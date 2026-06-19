import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitLabInstance, Pagination, ReviewDetail, ReviewList, ReviewRunReference } from '@hunkwise/contracts';
import type {
  GitLabDiscussionContext,
  GitLabReviewContext,
  GitLabReviewSnapshot,
  GitLabReviewStore,
  HunkwiseStore,
  CompleteAiReviewInput,
  AiOverviewPostRecord,
  NewInstanceRecord,
  PostAiFindingInput,
  RecordGitLabDiscussionInput,
  RecordAiOverviewPostInput,
  RecordGitLabReplyInput,
  RecordGitLabWebhookInput,
  RecordGitLabWebhookResult,
  UpdateInstanceRecord
} from '@hunkwise/db';
import type { GitLabAccessToken, InstanceCredentialProvider } from '../src/credentials.js';
import { AesGcmSecretCipher } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { GitLabReviewService } from '../src/gitlab-review-service.js';

class MemoryReviewStore implements HunkwiseStore, GitLabReviewStore {
  instances = new Map<string, GitLabInstance>();
  snapshots: GitLabReviewSnapshot[] = [];
  webhookEvents = new Map<string, { eventId: string; inProgress: boolean; failed: boolean; processed: boolean; reviewRunId: string | null }>();
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
  async listInstances(): Promise<GitLabInstance[]> { return [...this.instances.values()]; }
  async getInstance(id: string): Promise<GitLabInstance | null> { return this.instances.get(id) ?? null; }
  async createInstance(input: NewInstanceRecord): Promise<GitLabInstance> {
    const now = new Date().toISOString();
    const instance = { id: randomUUID(), name: input.name, baseUrl: input.baseUrl, hasAccessToken: true, createdAt: now, updatedAt: now };
    this.instances.set(instance.id, instance);
    return instance;
  }
  async updateInstance(id: string, input: UpdateInstanceRecord): Promise<GitLabInstance | null> {
    const current = this.instances.get(id);
    if (!current) return null;
    const updated = { ...current, ...(input.name === undefined ? {} : { name: input.name }), ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }) };
    this.instances.set(id, updated);
    return updated;
  }
  async deleteInstance(id: string): Promise<boolean> { return this.instances.delete(id); }
  async listReviews(page: Pagination): Promise<ReviewList> { return { items: [], total: 0, ...page }; }
  async getReview(): Promise<ReviewDetail | null> { return null; }
  async upsertGitLabReviewSnapshot(input: GitLabReviewSnapshot): Promise<ReviewRunReference> {
    const existing = this.snapshots.find((snapshot) =>
      snapshot.instanceId === input.instanceId &&
      snapshot.project.gitlabId === input.project.gitlabId &&
      snapshot.mergeRequest.gitlabIid === input.mergeRequest.gitlabIid &&
      snapshot.mergeRequest.sourceSha === input.mergeRequest.sourceSha
    );
    if (!existing) this.snapshots.push(input);
    return { runId: randomUUID(), status: 'completed', summary: input.summary };
  }
  async getReviewContext(): Promise<GitLabReviewContext | null> { return null; }
  async getDiscussionContext(): Promise<GitLabDiscussionContext | null> { return null; }
  async recordGitLabDiscussion(_input: RecordGitLabDiscussionInput): Promise<{ localDiscussionId: string }> { return { localDiscussionId: randomUUID() }; }
  async recordGitLabReply(_input: RecordGitLabReplyInput): Promise<void> {}
  async updateGitLabDiscussionResolved(): Promise<void> {}
  async startAiReview(): Promise<void> {}
  async completeAiReview(_input: CompleteAiReviewInput): Promise<void> {}
  async failAiReview(): Promise<void> {}
  async getAiOverviewPost(): Promise<AiOverviewPostRecord | null> { return null; }
  async recordAiFindingPosted(_input: PostAiFindingInput): Promise<void> {}
  async recordAiOverviewPosted(_input: RecordAiOverviewPostInput): Promise<void> {}
  async recordGitLabWebhook(_input: RecordGitLabWebhookInput): Promise<RecordGitLabWebhookResult> {
    const key = `${_input.instanceId}:${_input.eventKey}`;
    const existing = this.webhookEvents.get(key);
    if (!existing) {
      const event = { eventId: randomUUID(), inProgress: true, failed: false, processed: false, reviewRunId: null };
      this.webhookEvents.set(key, event);
      return { duplicate: false, eventId: event.eventId, state: 'claimed', reviewRunId: null };
    }
    if (existing.processed) {
      return { duplicate: true, eventId: existing.eventId, state: 'completed_duplicate', reviewRunId: existing.reviewRunId };
    }
    if (existing.inProgress && !existing.failed) {
      return { duplicate: true, eventId: existing.eventId, state: 'in_progress', reviewRunId: null };
    }
    existing.inProgress = true;
    existing.failed = false;
    return { duplicate: false, eventId: existing.eventId, state: 'claimed', reviewRunId: null };
  }
  async completeGitLabWebhook(eventId: string, reviewRunId: string | null): Promise<void> {
    for (const event of this.webhookEvents.values()) {
      if (event.eventId === eventId) {
        event.inProgress = false;
        event.failed = false;
        event.processed = true;
        event.reviewRunId = reviewRunId;
      }
    }
  }
  async failGitLabWebhook(eventId: string): Promise<void> {
    for (const event of this.webhookEvents.values()) {
      if (event.eventId === eventId) {
        event.inProgress = false;
        event.failed = true;
      }
    }
  }
}

class StaticCredentials implements InstanceCredentialProvider {
  async getAccessToken(): Promise<GitLabAccessToken> { return 'glpat-secret' as GitLabAccessToken; }
}

let server: http.Server;
let baseUrl: string;
const seenTokens: Array<string | string[] | undefined> = [];
let failMergeRequest = false;

const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};

beforeEach(async () => {
  seenTokens.length = 0;
  failMergeRequest = false;
  server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    seenTokens.push(request.headers['private-token']);
    if (request.url === '/gitlab/api/v4/projects/group%2Fproject/merge_requests/7') {
      if (failMergeRequest) {
        json(response, 500, { message: 'temporary outage' });
        return;
      }
      json(response, 200, {
        project_id: 12,
        iid: 7,
        title: 'Improve parser',
        source_branch: 'feature',
        target_branch: 'main',
        sha: 'head-sha',
        diff_refs: { base_sha: 'base-sha', start_sha: 'start-sha', head_sha: 'head-sha' },
        web_url: `${baseUrl}/group/project/-/merge_requests/7`,
        state: 'opened',
        author: { username: 'alice' },
        detailed_merge_status: 'mergeable'
      });
      return;
    }
    if (request.url === '/gitlab/api/v4/projects/12') {
      json(response, 200, { id: 12, path_with_namespace: 'group/project', default_branch: 'main', web_url: `${baseUrl}/group/project` });
      return;
    }
    if (request.url === '/gitlab/api/v4/projects/12/merge_requests/7/diffs?page=1&per_page=100') {
      json(response, 200, [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new', new_file: false, renamed_file: false, deleted_file: false }]);
      return;
    }
    if (request.url === '/gitlab/api/v4/projects/12/merge_requests/7/discussions?page=1&per_page=100') {
      json(response, 200, [{ id: 'discussion-1', notes: [{ id: 99, body: 'Existing comment', author: { username: 'bob' }, resolved: false, created_at: '2026-01-01T00:00:00Z' }] }]);
      return;
    }
    json(response, 404, { message: request.url });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  baseUrl = `http://127.0.0.1:${address.port}/gitlab`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('GitLab ingestion API', () => {
  it('ingests MR metadata, diffs, hunks, and discussions through mocked GitLab HTTP', async () => {
    const store = new MemoryReviewStore();
    const app = await buildApp({
      store,
      cipher: new AesGcmSecretCipher(Buffer.alloc(32, 1).toString('base64')),
      gitlabReview: new GitLabReviewService(store, new StaticCredentials())
    });
    const instance = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Local GitLab', baseUrl, accessToken: 'stored-secret' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reviews',
      payload: { instanceId: instance.json().id, mergeRequestUrl: `${baseUrl}/group/project/-/merge_requests/7` }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'completed', summary: 'GitLab ingestion complete' });
    expect(seenTokens.every((token) => token === 'glpat-secret')).toBe(true);
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0]).toMatchObject({
      project: { gitlabId: 12, pathWithNamespace: 'group/project' },
      mergeRequest: { gitlabIid: 7, sourceSha: 'head-sha', state: 'open' },
      files: [{ newPath: 'src/a.ts', additions: 1, deletions: 1, hunks: [{ oldStart: 1, newStart: 1 }] }],
      discussions: [{ gitlabDiscussionId: 'discussion-1', comments: [{ body: 'Existing comment', gitlabNoteId: '99' }] }]
    });
    await app.close();
  });

  it('returns structured 400s for malformed and ambiguous encoded MR URLs', async () => {
    const store = new MemoryReviewStore();
    const app = await buildApp({
      store,
      cipher: new AesGcmSecretCipher(Buffer.alloc(32, 1).toString('base64')),
      gitlabReview: new GitLabReviewService(store, new StaticCredentials())
    });
    const instance = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Local GitLab', baseUrl, accessToken: 'stored-secret' } });
    for (const mergeRequestUrl of [
      `${baseUrl}/group/project%ZZ/-/merge_requests/7`,
      `${baseUrl}/group/proj%2Fsub/-/merge_requests/7`,
      `${baseUrl}/group/proj%5Csub/-/merge_requests/7`
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reviews',
        payload: { instanceId: instance.json().id, mergeRequestUrl }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'unsafe_url' } });
    }
    await app.close();
  });

  it('reprocesses a failed webhook retry and suppresses completed duplicates', async () => {
    const store = new MemoryReviewStore();
    const app = await buildApp({
      store,
      cipher: new AesGcmSecretCipher(Buffer.alloc(32, 1).toString('base64')),
      gitlabReview: new GitLabReviewService(store, new StaticCredentials()),
      gitlabWebhookSecret: 'webhook-secret'
    });
    const instance = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Local GitLab', baseUrl, accessToken: 'stored-secret' } });
    const payload = { object_kind: 'merge_request', project: { path_with_namespace: 'group/project' }, object_attributes: { iid: 7 } };

    failMergeRequest = true;
    const failed = await app.inject({
      method: 'POST',
      url: `/api/webhooks/gitlab/${instance.json().id}`,
      headers: { 'x-gitlab-token': 'webhook-secret', 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'retry-event' },
      payload
    });
    expect(failed.statusCode).toBe(500);

    failMergeRequest = false;
    const retried = await app.inject({
      method: 'POST',
      url: `/api/webhooks/gitlab/${instance.json().id}`,
      headers: { 'x-gitlab-token': 'webhook-secret', 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'retry-event' },
      payload
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json()).toMatchObject({ accepted: true, duplicate: false });
    expect(store.snapshots).toHaveLength(1);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/webhooks/gitlab/${instance.json().id}`,
      headers: { 'x-gitlab-token': 'webhook-secret', 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'retry-event' },
      payload
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(store.snapshots).toHaveLength(1);
    await app.close();
  });
});
