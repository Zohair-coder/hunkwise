import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  CreateDiffDiscussion,
  CreateOverviewDiscussion,
  AiReviewPostResponse,
  GitLabDiscussionActionResponse,
  GitLabWebhookResponse,
  GitLabInstance,
  Pagination,
  ReviewDetail,
  ReviewList,
  ReviewRunReference,
  SubmitReview,
  TestGitLabInstanceResponse
} from '@hunkwise/contracts';
import type { HunkwiseStore, NewInstanceRecord, UpdateInstanceRecord } from '@hunkwise/db';
import { buildApp } from '../src/app.js';
import { AesGcmSecretCipher } from '../src/crypto.js';
import type { GitLabReviewActions } from '../src/gitlab-review-service.js';

class MemoryStore implements HunkwiseStore {
  instances = new Map<string, GitLabInstance>();
  encryptedTokens: string[] = [];
  failPing = false;
  review: ReviewDetail | null = null;
  async ping(): Promise<void> { if (this.failPing) throw new Error('down'); }
  async close(): Promise<void> {}
  async listInstances(): Promise<GitLabInstance[]> { return [...this.instances.values()]; }
  async getInstance(id: string): Promise<GitLabInstance | null> { return this.instances.get(id) ?? null; }
  async createInstance(input: NewInstanceRecord): Promise<GitLabInstance> {
    const now = new Date().toISOString();
    const value = { id: randomUUID(), name: input.name, baseUrl: input.baseUrl, hasAccessToken: true, createdAt: now, updatedAt: now };
    this.encryptedTokens.push(input.encryptedAccessToken);
    this.instances.set(value.id, value);
    return value;
  }
  async updateInstance(id: string, input: UpdateInstanceRecord): Promise<GitLabInstance | null> {
    const current = this.instances.get(id);
    if (!current) return null;
    const value = { ...current, ...(input.name ? { name: input.name } : {}), ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), updatedAt: new Date().toISOString() };
    if (input.encryptedAccessToken) this.encryptedTokens.push(input.encryptedAccessToken);
    this.instances.set(id, value);
    return value;
  }
  async deleteInstance(id: string): Promise<boolean> { return this.instances.delete(id); }
  async listReviews(page: Pagination): Promise<ReviewList> { return { items: [], total: 0, ...page }; }
  async getReview(id: string): Promise<ReviewDetail | null> { return this.review?.run.id === id ? this.review : null; }
}

class FakeGitLabReview implements GitLabReviewActions {
  submissions: SubmitReview[] = [];
  aiRuns: Array<{ reviewRunId: string; options: { autoPost?: boolean; force?: boolean } }> = [];
  aiPosts: Array<{ reviewRunId: string; input: { includeOverview: boolean; findingIds: string[] } }> = [];
  webhooks: Array<{ instanceId: string; eventType: string; eventKey: string | null; payload: unknown }> = [];
  async testInstance(): Promise<TestGitLabInstanceResponse> { return { ok: true, username: 'root', version: '17.0.0' }; }
  async submit(input: SubmitReview): Promise<ReviewRunReference> {
    this.submissions.push(input);
    return { runId: randomUUID(), status: 'completed', summary: 'GitLab ingestion complete' };
  }
  async refresh(): Promise<ReviewRunReference> { return { runId: randomUUID(), status: 'completed', summary: 'GitLab ingestion complete' }; }
  async runAiReview(reviewRunId: string, options: { autoPost?: boolean; force?: boolean } = {}): Promise<ReviewRunReference> {
    this.aiRuns.push({ reviewRunId, options });
    return { runId: reviewRunId, status: 'completed', summary: 'AI review complete' };
  }
  async postAiReview(reviewRunId: string, input: { includeOverview: boolean; findingIds: string[] }): Promise<AiReviewPostResponse> {
    this.aiPosts.push({ reviewRunId, input });
    return { items: [{ findingId: null, gitlabDiscussionId: 'discussion-ai', gitlabNoteId: 'note-ai', skipped: false }] };
  }
  async addOverviewDiscussion(_reviewRunId: string, _input: CreateOverviewDiscussion): Promise<GitLabDiscussionActionResponse> {
    return { gitlabDiscussionId: 'discussion-1', gitlabNoteId: 'note-1', resolved: false };
  }
  async addDiffDiscussion(_reviewRunId: string, _input: CreateDiffDiscussion): Promise<GitLabDiscussionActionResponse> {
    return { gitlabDiscussionId: 'discussion-2', gitlabNoteId: 'note-2', resolved: false };
  }
  async replyToDiscussion(): Promise<GitLabDiscussionActionResponse> { return { gitlabDiscussionId: 'discussion-1', gitlabNoteId: 'note-3' }; }
  async setDiscussionResolved(): Promise<GitLabDiscussionActionResponse> { return { gitlabDiscussionId: 'discussion-1', resolved: true }; }
  async handleWebhook(instanceId: string, eventType: string, eventKey: string | null, payload: unknown): Promise<GitLabWebhookResponse> {
    this.webhooks.push({ instanceId, eventType, eventKey, payload });
    return { accepted: true, duplicate: false, runId: randomUUID() };
  }
}

const setup = async () => {
  const store = new MemoryStore();
  const gitlabReview = new FakeGitLabReview();
  const app = await buildApp({
    store,
    cipher: new AesGcmSecretCipher(randomBytes(32).toString('base64')),
    gitlabReview,
    gitlabWebhookSecret: 'webhook-secret'
  });
  return { app, store, gitlabReview };
};

describe('API', () => {
  it('reports liveness and database readiness', async () => {
    const { app, store } = await setup();
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    store.failPing = true;
    const unavailable = await app.inject({ method: 'GET', url: '/health/ready', headers: { 'x-request-id': 'ready-outage' } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: { code: 'dependency_unavailable', requestId: 'ready-outage', details: { checks: { database: 'unavailable' } } } });
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    store.failPing = false;
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    await app.close();
  });

  it('creates, lists, updates and deletes instances without exposing tokens', async () => {
    const { app, store } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Team', baseUrl: 'https://gitlab.example.com/', accessToken: 'glpat-secret' } });
    expect(created.statusCode).toBe(201);
    const body = created.json<GitLabInstance>();
    expect(body).not.toHaveProperty('accessToken');
    expect(store.encryptedTokens[0]).not.toContain('glpat-secret');
    expect((await app.inject({ method: 'GET', url: '/api/instances' })).json().items).toHaveLength(1);
    expect((await app.inject({ method: 'PATCH', url: `/api/instances/${body.id}`, payload: { name: 'Platform' } })).json().name).toBe('Platform');
    expect((await app.inject({ method: 'DELETE', url: `/api/instances/${body.id}` })).statusCode).toBe(204);
    await app.close();
  });

  it('canonicalizes uppercase HTTP and HTTPS GitLab base URLs before storing', async () => {
    const { app } = await setup();
    const https = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { name: 'Upper HTTPS', baseUrl: 'HTTPS://GITLAB-UPPERCASE.EXAMPLE.COM/team/project/', accessToken: 'secret' }
    });
    expect(https.statusCode).toBe(201);
    expect(https.json().baseUrl).toBe('https://gitlab-uppercase.example.com/team/project');

    const http = await app.inject({
      method: 'PATCH',
      url: `/api/instances/${https.json().id}`,
      payload: { baseUrl: 'HTTP://GITLAB-HTTP-UPPERCASE.EXAMPLE.COM/team/project/' }
    });
    expect(http.statusCode).toBe(200);
    expect(http.json().baseUrl).toBe('http://gitlab-http-uppercase.example.com/team/project');
    await app.close();
  });

  it('validates requests and returns request IDs', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/instances', headers: { 'x-request-id': 'test-request' }, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.headers['x-request-id']).toBe('test-request');
    expect(response.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('rejects GitLab URLs containing userinfo', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Unsafe', baseUrl: 'https://user:password@gitlab.example.com', accessToken: 'secret' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('rejects GitLab base URL query strings and fragments without echoing them', async () => {
    const { app } = await setup();
    for (const baseUrl of [
      'https://gitlab.example.com/group?private_token=glpat-secret',
      'https://gitlab.example.com/group#access_token=glpat-secret'
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/instances',
        payload: { name: 'Unsafe', baseUrl, accessToken: 'secret' }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('validation_error');
      expect(response.body).not.toContain('glpat-secret');
    }

    const created = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { name: 'Safe', baseUrl: 'https://gitlab.example.com/group', accessToken: 'secret' }
    });
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/instances/${created.json().id}`,
      payload: { baseUrl: 'https://gitlab.example.com/group?private_token=glpat-secret' }
    });
    expect(updated.statusCode).toBe(400);
    expect(updated.body).not.toContain('glpat-secret');
    await app.close();
  });

  it('preserves parser, body limit, and UUID error semantics in the standard envelope', async () => {
    const { app } = await setup();
    const malformed = await app.inject({ method: 'POST', url: '/api/instances', headers: { 'content-type': 'application/json', 'x-request-id': 'bad-json' }, payload: '{"name":' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'invalid_json', requestId: 'bad-json' } });

    const oversized = await app.inject({ method: 'POST', url: '/api/instances', headers: { 'content-type': 'application/json', 'x-request-id': 'too-big' }, payload: `"${'x'.repeat(1024 * 1024 + 1)}"` });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ error: { code: 'payload_too_large', requestId: 'too-big' } });

    const invalidId = await app.inject({ method: 'GET', url: '/api/instances/not-a-uuid', headers: { 'x-request-id': 'bad-id' } });
    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.json()).toMatchObject({ error: { code: 'invalid_request', requestId: 'bad-id' } });
    await app.close();
  });

  it('submits review ingestion through the GitLab review service', async () => {
    const { app, gitlabReview } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Team', baseUrl: 'https://gitlab.example.com', accessToken: 'secret' } });
    const response = await app.inject({ method: 'POST', url: '/api/reviews', payload: { instanceId: created.json().id, mergeRequestUrl: 'https://gitlab.example.com/group/project/-/merge_requests/7' } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'completed', summary: 'GitLab ingestion complete' });
    expect(gitlabReview.submissions).toHaveLength(1);
    await app.close();
  });

  it('tests an instance connection and validates webhook tokens before dispatch', async () => {
    const { app, gitlabReview } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Team', baseUrl: 'https://gitlab.example.com', accessToken: 'secret' } });
    expect((await app.inject({ method: 'POST', url: `/api/instances/${created.json().id}/test` })).json()).toMatchObject({ ok: true, username: 'root' });

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/webhooks/gitlab/${created.json().id}`,
      headers: { 'x-gitlab-token': 'wrong', 'x-gitlab-event': 'Merge Request Hook' },
      payload: { object_kind: 'merge_request' }
    });
    expect(rejected.statusCode).toBe(401);

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/webhooks/gitlab/${created.json().id}`,
      headers: { 'x-gitlab-token': 'webhook-secret', 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'event-1' },
      payload: { object_kind: 'merge_request' }
    });
    expect(accepted.statusCode).toBe(202);
    expect(gitlabReview.webhooks).toMatchObject([{ eventType: 'Merge Request Hook', eventKey: 'event-1' }]);
    await app.close();
  });

  it('exposes GitLab discussion action endpoints', async () => {
    const { app } = await setup();
    const runId = randomUUID();
    const discussionId = randomUUID();
    expect((await app.inject({ method: 'POST', url: `/api/reviews/${runId}/gitlab/discussions`, payload: { body: 'Looks good' } })).statusCode).toBe(201);
    expect((await app.inject({
      method: 'POST',
      url: `/api/reviews/${runId}/gitlab/diff-discussions`,
      payload: {
        body: 'Please check this',
        position: { baseSha: 'base', startSha: 'start', headSha: 'head', oldPath: 'a.ts', newPath: 'a.ts', newLine: 3 }
      }
    })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/gitlab/discussions/${discussionId}/notes`, payload: { body: 'Reply' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'PUT', url: `/api/gitlab/discussions/${discussionId}/resolution`, payload: { resolved: true } })).statusCode).toBe(200);
    await app.close();
  });

  it('exposes AI review run and posting endpoints', async () => {
    const { app, gitlabReview } = await setup();
    const runId = randomUUID();
    const findingId = randomUUID();
    const run = await app.inject({ method: 'POST', url: `/api/reviews/${runId}/ai-review`, payload: { force: true, autoPost: true } });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ runId, status: 'completed', summary: 'AI review complete' });
    expect(gitlabReview.aiRuns).toEqual([{ reviewRunId: runId, options: { force: true, autoPost: true } }]);

    const post = await app.inject({ method: 'POST', url: `/api/reviews/${runId}/ai-review/post`, payload: { includeOverview: true, findingIds: [findingId] } });
    expect(post.statusCode).toBe(201);
    expect(post.json()).toMatchObject({ items: [{ gitlabDiscussionId: 'discussion-ai', skipped: false }] });
    expect(gitlabReview.aiPosts).toEqual([{ reviewRunId: runId, input: { includeOverview: true, findingIds: [findingId] } }]);
    await app.close();
  });

  it('serves persisted review detail through the detail contract', async () => {
    const { app, store } = await setup();
    const now = new Date().toISOString();
    const id = randomUUID();
    store.review = {
      run: { id, mergeRequestId: randomUUID(), status: 'completed', sourceSha: 'abc123', summary: null, errorMessage: null, aiModel: null, overviewCommentBody: null, startedAt: now, completedAt: now, createdAt: now, updatedAt: now },
      files: [], hunks: [], findings: [], discussions: [], comments: [], chatMessages: []
    };
    const response = await app.inject({ method: 'GET', url: `/api/reviews/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ run: { id }, files: [], findings: [], chatMessages: [] });
    await app.close();
  });
});
