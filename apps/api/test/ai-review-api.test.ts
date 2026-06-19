import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiReviewPostResponse, GitLabInstance, Pagination, ReviewDetail, ReviewList, ReviewRunReference } from '@hunkwise/contracts';
import type {
  AiReviewFindingRecord,
  CompleteAiReviewInput,
  GitLabDiscussionContext,
  GitLabReviewContext,
  GitLabReviewSnapshot,
  GitLabReviewStore,
  HunkwiseStore,
  NewInstanceRecord,
  PostAiFindingInput,
  RecordAiOverviewPostInput,
  RecordGitLabDiscussionInput,
  RecordGitLabReplyInput,
  RecordGitLabWebhookInput,
  RecordGitLabWebhookResult,
  UpdateInstanceRecord
} from '@hunkwise/db';
import { buildApp } from '../src/app.js';
import type { AiReviewClient } from '../src/ai-review.js';
import type { GitLabAccessToken, InstanceCredentialProvider } from '../src/credentials.js';
import { AesGcmSecretCipher } from '../src/crypto.js';
import { GitLabReviewService } from '../src/gitlab-review-service.js';

const now = new Date().toISOString();

class FakeAiClient implements AiReviewClient {
  calls = 0;
  constructor(private readonly output: string) {}
  async review(): Promise<string> {
    this.calls += 1;
    return this.output;
  }
}

class StaticCredentials implements InstanceCredentialProvider {
  async getAccessToken(): Promise<GitLabAccessToken> { return 'glpat-secret' as GitLabAccessToken; }
}

class MemoryAiStore implements HunkwiseStore, GitLabReviewStore {
  instance: GitLabInstance;
  context: GitLabReviewContext;
  detail: ReviewDetail;
  constructor(baseUrl: string) {
    const runId = randomUUID();
    const fileId = randomUUID();
    this.instance = { id: randomUUID(), name: 'GitLab', baseUrl, hasAccessToken: true, createdAt: now, updatedAt: now };
    this.context = {
      reviewRunId: runId,
      instanceId: this.instance.id,
      instanceBaseUrl: baseUrl,
      projectGitlabId: 12,
      projectPathWithNamespace: 'group/project',
      mergeRequestIid: 7,
      mergeRequestTitle: 'Fix parser',
      sourceBranch: 'feature',
      targetBranch: 'main',
      sourceSha: 'head-sha',
      targetSha: 'base-sha',
      mergeRequestUrl: `${baseUrl}/group/project/-/merge_requests/7`
    };
    this.detail = {
      run: {
        id: runId,
        mergeRequestId: randomUUID(),
        status: 'completed',
        sourceSha: 'head-sha',
        summary: 'GitLab ingestion complete',
        errorMessage: null,
        aiModel: null,
        overviewCommentBody: null,
        startedAt: now,
        completedAt: now,
        createdAt: now,
        updatedAt: now
      },
      files: [{ id: fileId, reviewRunId: runId, oldPath: 'src/a.ts', newPath: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
      hunks: [{ id: randomUUID(), diffFileId: fileId, oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, header: '@@ -1 +1,2 @@', patch: '@@ -1 +1,2 @@\n const x = 1;\n+throw new Error("boom")', position: 0 }],
      findings: [],
      discussions: [],
      comments: [],
      chatMessages: []
    };
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
  async listInstances(): Promise<GitLabInstance[]> { return [this.instance]; }
  async getInstance(id: string): Promise<GitLabInstance | null> { return id === this.instance.id ? this.instance : null; }
  async createInstance(_input: NewInstanceRecord): Promise<GitLabInstance> { return this.instance; }
  async updateInstance(_id: string, _input: UpdateInstanceRecord): Promise<GitLabInstance | null> { return this.instance; }
  async deleteInstance(): Promise<boolean> { return true; }
  async listReviews(page: Pagination): Promise<ReviewList> { return { items: [this.detail.run], total: 1, ...page }; }
  async getReview(id: string): Promise<ReviewDetail | null> { return id === this.detail.run.id ? this.detail : null; }
  async upsertGitLabReviewSnapshot(_input: GitLabReviewSnapshot): Promise<ReviewRunReference> { return { runId: this.detail.run.id, status: this.detail.run.status, summary: this.detail.run.summary }; }
  async getReviewContext(reviewRunId: string): Promise<GitLabReviewContext | null> { return reviewRunId === this.detail.run.id ? this.context : null; }
  async getDiscussionContext(): Promise<GitLabDiscussionContext | null> { return null; }
  async recordGitLabDiscussion(_input: RecordGitLabDiscussionInput): Promise<{ localDiscussionId: string }> { return { localDiscussionId: randomUUID() }; }
  async recordGitLabReply(_input: RecordGitLabReplyInput): Promise<void> {}
  async updateGitLabDiscussionResolved(): Promise<void> {}
  async recordGitLabWebhook(_input: RecordGitLabWebhookInput): Promise<RecordGitLabWebhookResult> { throw new Error('not used'); }
  async completeGitLabWebhook(): Promise<void> {}
  async failGitLabWebhook(): Promise<void> {}
  async startAiReview(): Promise<void> {
    this.detail.run = { ...this.detail.run, status: 'running', errorMessage: null, completedAt: null };
  }
  async completeAiReview(input: CompleteAiReviewInput): Promise<void> {
    this.detail.run = { ...this.detail.run, status: 'completed', summary: input.summary, aiModel: input.model, overviewCommentBody: input.overviewCommentBody, completedAt: now };
    this.detail.findings = input.findings.map((finding: AiReviewFindingRecord) => ({
      id: randomUUID(),
      reviewRunId: input.reviewRunId,
      diffHunkId: finding.diffHunkId,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      body: finding.rationale,
      rationale: finding.rationale,
      filePath: finding.filePath,
      line: finding.line,
      lineEnd: finding.lineEnd,
      confidence: finding.confidence,
      suggestedFix: finding.suggestedFix,
      shouldPost: finding.shouldPost,
      gitlabPosition: finding.gitlabPosition,
      gitlabDiscussionId: null,
      gitlabNoteId: null,
      postedAt: null,
      status: 'open',
      createdAt: now
    }));
  }
  async failAiReview(_reviewRunId: string, error: Error): Promise<void> {
    this.detail.run = { ...this.detail.run, status: 'failed', errorMessage: error.message, completedAt: now };
  }
  async recordAiFindingPosted(input: PostAiFindingInput): Promise<void> {
    this.detail.findings = this.detail.findings.map((finding) => finding.id === input.findingId
      ? { ...finding, gitlabDiscussionId: input.gitlabDiscussionId, gitlabNoteId: input.gitlabNoteId, postedAt: now }
      : finding);
  }
  async recordAiOverviewPosted(input: RecordAiOverviewPostInput): Promise<void> {
    const discussionId = randomUUID();
    this.detail.discussions.push({ id: discussionId, reviewRunId: input.reviewRunId, findingId: null, gitlabDiscussionId: input.gitlabDiscussionId, resolved: false, createdAt: now });
    this.detail.comments.push({ id: randomUUID(), discussionId, authorType: 'hunkwise', authorName: 'Hunkwise', body: input.body, gitlabNoteId: input.gitlabNoteId, createdAt: now });
  }
}

let server: http.Server;
let baseUrl: string;
const posted: unknown[] = [];

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

beforeEach(async () => {
  posted.length = 0;
  server = http.createServer((request, response) => {
    void (async () => {
      if (request.method === 'POST' && request.url === '/gitlab/api/v4/projects/12/merge_requests/7/discussions') {
        posted.push(await readBody(request));
        json(response, 201, { id: `discussion-${posted.length}`, notes: [{ id: `note-${posted.length}`, body: 'posted', author: { username: 'bot' } }] });
        return;
      }
      json(response, 404, { message: request.url });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  baseUrl = `http://127.0.0.1:${address.port}/gitlab`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('AI review API', () => {
  it('runs mocked OpenAI review, persists findings, and posts selected comments to mocked GitLab', async () => {
    const aiClient = new FakeAiClient(JSON.stringify({
      summary: 'One high-confidence issue.',
      overviewCommentBody: 'Hunkwise reviewed the MR and found one issue.',
      findings: [{
        category: 'bug',
        severity: 'error',
        confidence: 0.95,
        title: 'Unexpected throw in parser',
        rationale: 'The new line throws during normal parsing.',
        filePath: 'src/a.ts',
        line: 2,
        lineEnd: 2,
        suggestedFix: 'Return a parse error instead of throwing.',
        shouldPost: true
      }]
    }));
    const store = new MemoryAiStore(baseUrl);
    const app = await buildApp({
      store,
      cipher: new AesGcmSecretCipher(Buffer.alloc(32, 2).toString('base64')),
      gitlabReview: new GitLabReviewService(store, new StaticCredentials(), { aiClient, aiModel: 'gpt-test' })
    });

    const run = await app.inject({ method: 'POST', url: `/api/reviews/${store.detail.run.id}/ai-review`, payload: { force: true } });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ status: 'completed', summary: 'One high-confidence issue.' });
    expect(aiClient.calls).toBe(1);

    const detail = await app.inject({ method: 'GET', url: `/api/reviews/${store.detail.run.id}` });
    expect(detail.json()).toMatchObject({
      run: { aiModel: 'gpt-test', overviewCommentBody: 'Hunkwise reviewed the MR and found one issue.' },
      findings: [{ category: 'bug', shouldPost: true, gitlabPosition: { newLine: 2 } }]
    });

    const findingId = store.detail.findings[0]!.id;
    const postedResponse = await app.inject({
      method: 'POST',
      url: `/api/reviews/${store.detail.run.id}/ai-review/post`,
      payload: { includeOverview: true, findingIds: [findingId, findingId] }
    });
    expect(postedResponse.statusCode).toBe(201);
    expect(postedResponse.json<AiReviewPostResponse>().items).toHaveLength(2);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({ position: { base_sha: 'base-sha', head_sha: 'head-sha', new_line: 2 } });

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/reviews/${store.detail.run.id}/ai-review/post`,
      payload: { includeOverview: true, findingIds: [findingId] }
    });
    expect(duplicate.json<AiReviewPostResponse>().items.every((item) => item.skipped)).toBe(true);
    expect(posted).toHaveLength(2);
    await app.close();
  });

  it('marks invalid model output failed with a sanitized error', async () => {
    const store = new MemoryAiStore(baseUrl);
    const app = await buildApp({
      store,
      cipher: new AesGcmSecretCipher(Buffer.alloc(32, 3).toString('base64')),
      gitlabReview: new GitLabReviewService(store, new StaticCredentials(), { aiClient: new FakeAiClient('{ "bad": "sk-secret12345678"') })
    });
    const response = await app.inject({ method: 'POST', url: `/api/reviews/${store.detail.run.id}/ai-review`, payload: { force: true } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'failed' });
    expect(store.detail.run.errorMessage).not.toContain('sk-secret12345678');
    await app.close();
  });
});
