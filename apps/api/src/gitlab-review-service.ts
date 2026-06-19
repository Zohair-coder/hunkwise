import { createHash } from 'node:crypto';
import type {
  AiReviewPostResponse,
  CreateDiffDiscussion,
  CreateOverviewDiscussion,
  Finding,
  GitLabDiscussionActionResponse,
  GitLabWebhookResponse,
  ReviewRunReference,
  SubmitReview,
  TestGitLabInstanceResponse
} from '@hunkwise/contracts';
import { sanitizeSecrets, type GitLabInstance } from '@hunkwise/contracts';
import type { AiReviewStore, GitLabReviewSnapshot, GitLabReviewStore, HunkwiseStore } from '@hunkwise/db';
import {
  type AiReviewClient,
  buildReviewPrompt,
  parseModelOutput,
  toFindingRecords
} from './ai-review.js';
import type { InstanceCredentialProvider } from './credentials.js';
import { diffFileStatus, parseUnifiedDiff } from './diff.js';
import { GitLabClient, type GitLabClientOptions, type GitLabDiscussion, type GitLabMergeRequest, type GitLabNote } from './gitlab-client.js';
import { parseGitLabMergeRequestUrl } from './gitlab-url.js';

const ingestionSummary = 'GitLab ingestion complete';

export class GitLabReviewServiceError extends Error {
  constructor(readonly code: 'instance_not_found' | 'token_not_found' | 'review_not_found' | 'discussion_not_found' | 'unsupported_webhook' | 'ai_not_configured' | 'finding_not_found' | 'finding_not_postable', message: string) {
    super(message);
    this.name = 'GitLabReviewServiceError';
  }
}

type Store = HunkwiseStore & GitLabReviewStore & AiReviewStore;

export interface GitLabReviewServiceOptions {
  clientFactory?: (options: GitLabClientOptions) => GitLabClient;
  aiClient?: AiReviewClient;
  aiModel?: string;
}

export interface GitLabReviewActions {
  testInstance(instanceId: string): Promise<TestGitLabInstanceResponse>;
  submit(input: SubmitReview): Promise<ReviewRunReference>;
  refresh(reviewRunId: string): Promise<ReviewRunReference>;
  runAiReview(reviewRunId: string, options?: { autoPost?: boolean; force?: boolean }): Promise<ReviewRunReference>;
  postAiReview(reviewRunId: string, input: { includeOverview: boolean; findingIds: string[] }): Promise<AiReviewPostResponse>;
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
  readonly #aiClient: AiReviewClient | null;
  readonly #aiModel: string;

  constructor(store: Store, credentials: InstanceCredentialProvider, options: GitLabReviewServiceOptions = {}) {
    this.#store = store;
    this.#credentials = credentials;
    this.#clientFactory = options.clientFactory ?? ((clientOptions) => new GitLabClient(clientOptions));
    this.#aiClient = options.aiClient ?? null;
    this.#aiModel = options.aiModel ?? 'gpt-4.1-mini';
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
    const result = await this.#ingest(instance, parsed.projectPath, parsed.mergeRequestIid);
    if (!input.runAi) return result;
    const reviewed = await this.runAiReview(result.runId, { autoPost: input.autoPost });
    return reviewed;
  }

  async refresh(reviewRunId: string): Promise<ReviewRunReference> {
    const context = await this.#store.getReviewContext(reviewRunId);
    if (!context) throw new GitLabReviewServiceError('review_not_found', 'Review run not found');
    const instance = await this.#instance(context.instanceId);
    const result = await this.#ingest(instance, context.projectPathWithNamespace, context.mergeRequestIid);
    return result;
  }

  async runAiReview(reviewRunId: string, options: { autoPost?: boolean; force?: boolean } = {}): Promise<ReviewRunReference> {
    if (!this.#aiClient) throw new GitLabReviewServiceError('ai_not_configured', 'OpenAI review is not configured');
    const context = await this.#store.getReviewContext(reviewRunId);
    if (!context) throw new GitLabReviewServiceError('review_not_found', 'Review run not found');
    const detail = await this.#store.getReview(reviewRunId);
    if (!detail) throw new GitLabReviewServiceError('review_not_found', 'Review run not found');
    if (!options.force && detail.run.status === 'completed' && detail.findings.length > 0) {
      return { runId: reviewRunId, status: detail.run.status, summary: detail.run.summary };
    }

    await this.#store.startAiReview(reviewRunId);
    try {
      const prompt = buildReviewPrompt(detail, context);
      const raw = await this.#aiClient.review({ model: this.#aiModel, system: prompt.system, user: prompt.user });
      const output = parseModelOutput(raw);
      await this.#store.completeAiReview({
        reviewRunId,
        model: this.#aiModel,
        summary: output.summary,
        overviewCommentBody: output.overviewCommentBody,
        findings: toFindingRecords(output, detail, context)
      });
      if (options.autoPost) {
        const updated = await this.#store.getReview(reviewRunId);
        const postable = updated?.findings.filter((finding) => finding.shouldPost).map((finding) => finding.id) ?? [];
        await this.postAiReview(reviewRunId, { includeOverview: true, findingIds: postable });
      }
      const updated = await this.#store.getReview(reviewRunId);
      return { runId: reviewRunId, status: updated?.run.status ?? 'completed', summary: updated?.run.summary ?? output.summary };
    } catch (error) {
      const safe = sanitizeServiceError(error);
      await this.#store.failAiReview(reviewRunId, safe);
      return { runId: reviewRunId, status: 'failed', summary: null };
    }
  }

  async postAiReview(reviewRunId: string, input: { includeOverview: boolean; findingIds: string[] }): Promise<AiReviewPostResponse> {
    const context = await this.#store.getReviewContext(reviewRunId);
    if (!context) throw new GitLabReviewServiceError('review_not_found', 'Review run not found');
    const detail = await this.#store.getReview(reviewRunId);
    if (!detail) throw new GitLabReviewServiceError('review_not_found', 'Review run not found');
    const client = await this.#client(await this.#instance(context.instanceId));
    const items: AiReviewPostResponse['items'] = [];

    if (input.includeOverview) {
      const overviewBody = detail.run.overviewCommentBody;
      const existingOverview = await this.#store.getAiOverviewPost(reviewRunId);
      if (existingOverview) {
        items.push({
          findingId: null,
          gitlabDiscussionId: existingOverview.gitlabDiscussionId,
          gitlabNoteId: existingOverview.gitlabNoteId,
          skipped: true,
          reason: 'already_posted'
        });
      } else if (!overviewBody) {
        items.push({ findingId: null, gitlabDiscussionId: null, skipped: true, reason: 'missing_review_result' });
      } else {
        const body = overviewBody;
        const discussion = await client.createOverviewDiscussion(context.projectGitlabId, context.mergeRequestIid, body);
        const note = firstNote(discussion);
        await this.#store.recordAiOverviewPosted({
          reviewRunId,
          gitlabDiscussionId: discussion.id,
          gitlabNoteId: note?.id === undefined ? null : String(note.id),
          body
        });
        items.push({ findingId: null, gitlabDiscussionId: discussion.id, gitlabNoteId: note?.id === undefined ? null : String(note.id), skipped: false });
      }
    }

    const uniqueFindingIds = [...new Set(input.findingIds)];
    for (const findingId of uniqueFindingIds) {
      const finding = detail.findings.find((candidate) => candidate.id === findingId);
      if (!finding) throw new GitLabReviewServiceError('finding_not_found', 'AI finding not found');
      if (finding.gitlabDiscussionId) {
        items.push({ findingId, gitlabDiscussionId: finding.gitlabDiscussionId, gitlabNoteId: finding.gitlabNoteId, skipped: true, reason: 'already_posted' });
        continue;
      }
      if (!finding.shouldPost || !finding.gitlabPosition) {
        items.push({ findingId, gitlabDiscussionId: null, skipped: true, reason: 'not_postable' });
        continue;
      }
      const body = findingCommentBody(finding);
      const discussion = await client.createDiffDiscussion(context.projectGitlabId, context.mergeRequestIid, body, finding.gitlabPosition);
      const note = firstNote(discussion);
      const gitlabNoteId = note?.id === undefined ? null : String(note.id);
      await this.#store.recordAiFindingPosted({ reviewRunId, findingId, gitlabDiscussionId: discussion.id, gitlabNoteId });
      items.push({ findingId, gitlabDiscussionId: discussion.id, gitlabNoteId, skipped: false });
    }
    return { items };
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
    if (event.state === 'completed_duplicate') return { accepted: true, duplicate: true, runId: event.reviewRunId };
    if (event.state === 'in_progress') return { accepted: true, duplicate: true, runId: null };

    const target = webhookTarget(payload);
    if (!target) {
      await this.#store.completeGitLabWebhook(event.eventId, null);
      throw new GitLabReviewServiceError('unsupported_webhook', 'Webhook does not reference a merge request');
    }

    try {
      const result = await this.#ingest(instance, target.projectPath, target.mergeRequestIid);
      await this.#store.completeGitLabWebhook(event.eventId, result.runId);
      return { accepted: true, duplicate: false, runId: result.runId };
    } catch (error) {
      await this.#store.failGitLabWebhook(event.eventId, error instanceof Error ? error : new Error('Webhook processing failed'));
      throw error;
    }
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
        startSha: mergeRequest.diff_refs?.start_sha ?? mergeRequest.diff_refs?.base_sha ?? 'unknown',
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

const sanitizeServiceError = (error: unknown): Error => {
  const message = error instanceof Error ? error.message : 'AI review failed';
  return new Error(sanitizeSecrets(message).slice(0, 2000));
};

const findingCommentBody = (finding: Finding): string => {
  const parts = [
    `**${finding.title}**`,
    finding.rationale,
    finding.suggestedFix ? `Suggested fix: ${finding.suggestedFix}` : null,
    `Category: ${finding.category}; severity: ${finding.severity}; confidence: ${Math.round(finding.confidence * 100)}%`
  ].filter((part): part is string => part !== null);
  return parts.join('\n\n');
};
