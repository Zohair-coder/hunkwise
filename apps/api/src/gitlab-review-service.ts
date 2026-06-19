import { createHash } from 'node:crypto';
import type {
  CreateDiffDiscussion,
  CreateOverviewDiscussion,
  GitLabDiscussionActionResponse,
  GitLabWebhookResponse,
  ReviewRunReference,
  SubmitReview,
  TestGitLabInstanceResponse
} from '@hunkwise/contracts';
import type { GitLabInstance } from '@hunkwise/contracts';
import type { GitLabReviewSnapshot, GitLabReviewStore, HunkwiseStore } from '@hunkwise/db';
import type { InstanceCredentialProvider } from './credentials.js';
import { diffFileStatus, parseUnifiedDiff } from './diff.js';
import { GitLabClient, type GitLabClientOptions, type GitLabDiscussion, type GitLabMergeRequest, type GitLabNote } from './gitlab-client.js';
import { parseGitLabMergeRequestUrl } from './gitlab-url.js';

const ingestionSummary = 'GitLab ingestion complete; AI review pending Slice 3';

export class GitLabReviewServiceError extends Error {
  constructor(readonly code: 'instance_not_found' | 'token_not_found' | 'review_not_found' | 'discussion_not_found' | 'unsupported_webhook', message: string) {
    super(message);
    this.name = 'GitLabReviewServiceError';
  }
}

type Store = HunkwiseStore & GitLabReviewStore;

export interface GitLabReviewServiceOptions {
  clientFactory?: (options: GitLabClientOptions) => GitLabClient;
}

export interface GitLabReviewActions {
  testInstance(instanceId: string): Promise<TestGitLabInstanceResponse>;
  submit(input: SubmitReview): Promise<ReviewRunReference>;
  refresh(reviewRunId: string): Promise<ReviewRunReference>;
  addOverviewDiscussion(reviewRunId: string, input: CreateOverviewDiscussion): Promise<GitLabDiscussionActionResponse>;
  addDiffDiscussion(reviewRunId: string, input: CreateDiffDiscussion): Promise<GitLabDiscussionActionResponse>;
  replyToDiscussion(localDiscussionId: string, body: string): Promise<GitLabDiscussionActionResponse>;
  setDiscussionResolved(localDiscussionId: string, resolved: boolean): Promise<GitLabDiscussionActionResponse>;
  handleWebhook(instanceId: string, eventType: string, eventKey: string | null, payload: unknown): Promise<GitLabWebhookResponse>;
}

export class GitLabReviewService implements GitLabReviewActions {
  readonly #store: Store;
  readonly #credentials: InstanceCredentialProvider;
  readonly #clientFactory: (options: GitLabClientOptions) => GitLabClient;

  constructor(store: Store, credentials: InstanceCredentialProvider, options: GitLabReviewServiceOptions = {}) {
    this.#store = store;
    this.#credentials = credentials;
    this.#clientFactory = options.clientFactory ?? ((clientOptions) => new GitLabClient(clientOptions));
  }

  async testInstance(instanceId: string): Promise<TestGitLabInstanceResponse> {
    const instance = await this.#instance(instanceId);
    const client = await this.#client(instance);
    const result = await client.testConnection();
    return { ok: true, ...result };
  }

  async submit(input: SubmitReview): Promise<ReviewRunReference> {
    const instance = await this.#instance(input.instanceId);
    const parsed = parseGitLabMergeRequestUrl(instance.baseUrl, input.mergeRequestUrl);
    return this.#ingest(instance, parsed.projectPath, parsed.mergeRequestIid);
  }

  async refresh(reviewRunId: string): Promise<ReviewRunReference> {
    const context = await this.#store.getReviewContext(reviewRunId);
    if (!context) throw new GitLabReviewServiceError('review_not_found', 'Review run not found');
    const instance = await this.#instance(context.instanceId);
    return this.#ingest(instance, context.projectPathWithNamespace, context.mergeRequestIid);
  }

  async addOverviewDiscussion(reviewRunId: string, input: CreateOverviewDiscussion): Promise<GitLabDiscussionActionResponse> {
    const context = await this.#store.getReviewContext(reviewRunId);
    if (!context) throw new GitLabReviewServiceError('review_not_found', 'Review run not found');
    const client = await this.#client(await this.#instance(context.instanceId));
    const discussion = await client.createOverviewDiscussion(context.projectGitlabId, context.mergeRequestIid, input.body);
    const note = firstNote(discussion);
    await this.#store.recordGitLabDiscussion({
      reviewRunId,
      gitlabDiscussionId: discussion.id,
      resolved: note?.resolved ?? false,
      comment: gitLabNoteToComment(note, input.body)
    });
    return { gitlabDiscussionId: discussion.id, gitlabNoteId: note?.id === undefined ? null : String(note.id), resolved: note?.resolved ?? false };
  }

  async addDiffDiscussion(reviewRunId: string, input: CreateDiffDiscussion): Promise<GitLabDiscussionActionResponse> {
    const context = await this.#store.getReviewContext(reviewRunId);
    if (!context) throw new GitLabReviewServiceError('review_not_found', 'Review run not found');
    const client = await this.#client(await this.#instance(context.instanceId));
    const discussion = await client.createDiffDiscussion(context.projectGitlabId, context.mergeRequestIid, input.body, input.position);
    const note = firstNote(discussion);
    await this.#store.recordGitLabDiscussion({
      reviewRunId,
      gitlabDiscussionId: discussion.id,
      resolved: note?.resolved ?? false,
      comment: gitLabNoteToComment(note, input.body)
    });
    return { gitlabDiscussionId: discussion.id, gitlabNoteId: note?.id === undefined ? null : String(note.id), resolved: note?.resolved ?? false };
  }

  async replyToDiscussion(localDiscussionId: string, body: string): Promise<GitLabDiscussionActionResponse> {
    const context = await this.#store.getDiscussionContext(localDiscussionId);
    if (!context) throw new GitLabReviewServiceError('discussion_not_found', 'Discussion not found');
    const client = await this.#client(await this.#instance(context.instanceId));
    const note = await client.replyToDiscussion(context.projectGitlabId, context.mergeRequestIid, context.gitlabDiscussionId, body);
    await this.#store.recordGitLabReply({ localDiscussionId, authorName: 'Hunkwise', body, gitlabNoteId: String(note.id) });
    return { gitlabDiscussionId: context.gitlabDiscussionId, gitlabNoteId: String(note.id) };
  }

  async setDiscussionResolved(localDiscussionId: string, resolved: boolean): Promise<GitLabDiscussionActionResponse> {
    const context = await this.#store.getDiscussionContext(localDiscussionId);
    if (!context) throw new GitLabReviewServiceError('discussion_not_found', 'Discussion not found');
    const client = await this.#client(await this.#instance(context.instanceId));
    const discussion = await client.setDiscussionResolved(context.projectGitlabId, context.mergeRequestIid, context.gitlabDiscussionId, resolved);
    await this.#store.updateGitLabDiscussionResolved(localDiscussionId, resolved);
    return { gitlabDiscussionId: discussion.id, resolved };
  }

  async handleWebhook(instanceId: string, eventType: string, eventKey: string | null, payload: unknown): Promise<GitLabWebhookResponse> {
    const instance = await this.#instance(instanceId);
    const key = eventKey ?? fallbackWebhookKey(eventType, payload);
    const event = await this.#store.recordGitLabWebhook({ instanceId, eventKey: key, eventType, payload });
    if (event.duplicate) return { accepted: true, duplicate: true, runId: null };

    const target = webhookTarget(payload);
    if (!target) {
      await this.#store.completeGitLabWebhook(event.eventId, null);
      throw new GitLabReviewServiceError('unsupported_webhook', 'Webhook does not reference a merge request');
    }

    const result = await this.#ingest(instance, target.projectPath, target.mergeRequestIid);
    await this.#store.completeGitLabWebhook(event.eventId, result.runId);
    return { accepted: true, duplicate: false, runId: result.runId };
  }

  async #ingest(instance: GitLabInstance, projectPath: string, mergeRequestIid: number): Promise<ReviewRunReference> {
    const client = await this.#client(instance);
    const mergeRequest = await client.getMergeRequest(projectPath, mergeRequestIid);
    const project = await client.getProject(mergeRequest.project_id);
    const [diffs, discussions] = await Promise.all([
      client.listMergeRequestDiffs(mergeRequest.project_id, mergeRequest.iid),
      client.listMergeRequestDiscussions(mergeRequest.project_id, mergeRequest.iid)
    ]);

    const snapshot: GitLabReviewSnapshot = {
      instanceId: instance.id,
      project: {
        gitlabId: project.id,
        pathWithNamespace: project.path_with_namespace,
        defaultBranch: project.default_branch ?? null,
        webUrl: project.web_url
      },
      mergeRequest: {
        gitlabIid: mergeRequest.iid,
        title: mergeRequest.title,
        authorUsername: mergeRequest.author?.username ?? mergeRequest.author?.name ?? 'unknown',
        sourceBranch: mergeRequest.source_branch,
        targetBranch: mergeRequest.target_branch,
        sourceSha: mergeRequest.sha ?? mergeRequest.diff_refs?.head_sha ?? 'unknown',
        targetSha: mergeRequest.diff_refs?.base_sha ?? mergeRequest.diff_refs?.start_sha ?? 'unknown',
        state: mergeRequestState(mergeRequest),
        webUrl: mergeRequest.web_url
      },
      files: diffs.map((file) => {
        const parsed = parseUnifiedDiff(file.diff ?? '');
        return {
          oldPath: file.old_path || null,
          newPath: file.new_path,
          status: diffFileStatus(file),
          additions: parsed.additions,
          deletions: parsed.deletions,
          hunks: parsed.hunks
        };
      }),
      discussions: discussions.map(gitLabDiscussionToSnapshot),
      summary: ingestionSummary
    };
    return this.#store.upsertGitLabReviewSnapshot(snapshot);
  }

  async #instance(instanceId: string): Promise<GitLabInstance> {
    const instance = await this.#store.getInstance(instanceId);
    if (!instance) throw new GitLabReviewServiceError('instance_not_found', 'GitLab instance not found');
    return instance;
  }

  async #client(instance: GitLabInstance): Promise<GitLabClient> {
    const token = await this.#credentials.getAccessToken(instance.id);
    if (!token) throw new GitLabReviewServiceError('token_not_found', 'GitLab instance token not found');
    return this.#clientFactory({ baseUrl: instance.baseUrl, token });
  }
}

const mergeRequestState = (mergeRequest: GitLabMergeRequest): 'open' | 'merged' | 'closed' => {
  if (mergeRequest.state === 'merged') return 'merged';
  if (mergeRequest.state === 'closed') return 'closed';
  return 'open';
};

const firstNote = (discussion: GitLabDiscussion): GitLabNote | null => discussion.notes?.[0] ?? null;

const gitLabNoteToComment = (note: GitLabNote | null, fallbackBody: string) => ({
  authorType: 'hunkwise' as const,
  authorName: note?.author?.username ?? note?.author?.name ?? 'Hunkwise',
  body: note?.body ?? fallbackBody,
  gitlabNoteId: note?.id === undefined ? null : String(note.id),
  ...(note?.created_at === undefined ? {} : { createdAt: note.created_at })
});

const gitLabDiscussionToSnapshot = (discussion: GitLabDiscussion) => ({
  gitlabDiscussionId: discussion.id,
  resolved: discussion.notes?.some((note) => note.resolved) ?? false,
  comments: (discussion.notes ?? []).map((note) => ({
    authorType: 'gitlab' as const,
    authorName: note.author?.username ?? note.author?.name ?? 'GitLab',
    body: note.body,
    gitlabNoteId: String(note.id),
    ...(note.created_at === undefined ? {} : { createdAt: note.created_at })
  }))
});

const fallbackWebhookKey = (eventType: string, payload: unknown): string =>
  createHash('sha256').update(`${eventType}:${JSON.stringify(payload)}`).digest('hex');

const getRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const getNumber = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
const getString = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

const webhookTarget = (payload: unknown): { projectPath: string; mergeRequestIid: number } | null => {
  const body = getRecord(payload);
  if (!body) return null;
  const project = getRecord(body.project);
  const objectAttributes = getRecord(body.object_attributes);
  const mergeRequest = getRecord(body.merge_request);
  const projectPath = getString(project?.path_with_namespace);
  const iid = getNumber(objectAttributes?.iid) ?? getNumber(mergeRequest?.iid);
  return projectPath && iid ? { projectPath, mergeRequestIid: iid } : null;
};
