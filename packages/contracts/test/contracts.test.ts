import { describe, expect, it } from 'vitest';
import {
  createDiffDiscussionSchema,
  createGitLabInstanceSchema,
  aiReviewPostResponseSchema,
  findingSchema,
  gitLabDiscussionActionResponseSchema,
  gitLabWebhookResponseSchema,
  postAiReviewSchema,
  reviewRunReferenceSchema,
  submitReviewSchema,
  triggerAiReviewSchema,
  updateDiscussionResolutionSchema,
  updateGitLabInstanceSchema
} from '../src/index.js';

describe('API contracts', () => {
  it('normalizes instance URLs', () => {
    const value = createGitLabInstanceSchema.parse({ name: 'Work', baseUrl: 'https://gitlab.example.com/', accessToken: 'secret' });
    expect(value.baseUrl).toBe('https://gitlab.example.com');
  });

  it('canonicalizes uppercase instance URL scheme and host before persistence', () => {
    const https = createGitLabInstanceSchema.parse({ name: 'Work', baseUrl: 'HTTPS://GITLAB-UPPERCASE.EXAMPLE.COM/team/project/', accessToken: 'secret' });
    const http = updateGitLabInstanceSchema.parse({ baseUrl: 'HTTP://GITLAB-UPPERCASE.EXAMPLE.COM/team/project/' });
    expect(https.baseUrl).toBe('https://gitlab-uppercase.example.com/team/project');
    expect(http.baseUrl).toBe('http://gitlab-uppercase.example.com/team/project');
  });

  it('allows only HTTP(S) instance URLs', () => {
    expect(createGitLabInstanceSchema.safeParse({ name: 'Work', baseUrl: 'ftp://gitlab.example.com', accessToken: 'secret' }).success).toBe(false);
  });

  it('rejects instance URLs containing credentials', () => {
    expect(createGitLabInstanceSchema.safeParse({ name: 'Work', baseUrl: 'https://user:password@gitlab.example.com', accessToken: 'secret' }).success).toBe(false);
    expect(createGitLabInstanceSchema.safeParse({ name: 'Work', baseUrl: 'https://user@gitlab.example.com', accessToken: 'secret' }).success).toBe(false);
  });

  it('rejects instance URLs containing query strings or fragments', () => {
    expect(createGitLabInstanceSchema.safeParse({ name: 'Work', baseUrl: 'https://gitlab.example.com/group?private_token=secret', accessToken: 'secret' }).success).toBe(false);
    expect(createGitLabInstanceSchema.safeParse({ name: 'Work', baseUrl: 'https://gitlab.example.com/group#access_token=secret', accessToken: 'secret' }).success).toBe(false);
    expect(updateGitLabInstanceSchema.safeParse({ baseUrl: 'https://gitlab.example.com?' }).success).toBe(false);
    expect(updateGitLabInstanceSchema.safeParse({ baseUrl: 'https://gitlab.example.com#' }).success).toBe(false);
    expect(createGitLabInstanceSchema.safeParse({ name: 'Work', baseUrl: ' https://gitlab.example.com/group', accessToken: 'secret' }).success).toBe(false);
  });

  it('rejects empty updates', () => {
    expect(updateGitLabInstanceSchema.safeParse({}).success).toBe(false);
  });

  it('requires a valid MR submission', () => {
    expect(submitReviewSchema.safeParse({ instanceId: 'not-an-id', mergeRequestUrl: 'gitlab/project/1' }).success).toBe(false);
    expect(submitReviewSchema.parse({
      instanceId: '05b6f6a5-1ac5-4499-a7dd-f2fd0f310351',
      mergeRequestUrl: 'https://gitlab.example.com/group/project/-/merge_requests/1'
    })).toMatchObject({ runAi: false, autoPost: false });
  });

  it('validates Slice 2 response and discussion contracts', () => {
    expect(reviewRunReferenceSchema.parse({
      runId: '05b6f6a5-1ac5-4499-a7dd-f2fd0f310351',
      status: 'completed',
      summary: 'GitLab ingestion complete'
    }).status).toBe('completed');
    expect(createDiffDiscussionSchema.safeParse({
      body: 'Comment',
      position: { baseSha: 'base', startSha: 'start', headSha: 'head', oldPath: 'a.ts', newPath: 'a.ts', newLine: 1 }
    }).success).toBe(true);
    expect(createDiffDiscussionSchema.safeParse({
      body: 'Comment',
      position: { baseSha: 'base', startSha: 'start', headSha: 'head', oldPath: 'a.ts', newPath: 'a.ts' }
    }).success).toBe(false);
    expect(updateDiscussionResolutionSchema.parse({ resolved: true }).resolved).toBe(true);
    expect(gitLabDiscussionActionResponseSchema.parse({ gitlabDiscussionId: 'abc', gitlabNoteId: null }).gitlabDiscussionId).toBe('abc');
    expect(gitLabWebhookResponseSchema.parse({ accepted: true, duplicate: false, runId: null }).accepted).toBe(true);
  });

  it('validates Slice 3 AI review contracts', () => {
    expect(triggerAiReviewSchema.parse({})).toEqual({ autoPost: false, force: false });
    expect(postAiReviewSchema.safeParse({}).success).toBe(false);
    expect(postAiReviewSchema.parse({ includeOverview: true })).toEqual({ includeOverview: true, findingIds: [] });
    expect(aiReviewPostResponseSchema.parse({
      items: [{ findingId: null, gitlabDiscussionId: 'discussion-1', gitlabNoteId: 'note-1', skipped: false }]
    }).items[0]?.skipped).toBe(false);
    expect(findingSchema.parse({
      id: '05b6f6a5-1ac5-4499-a7dd-f2fd0f310351',
      reviewRunId: '15b6f6a5-1ac5-4499-a7dd-f2fd0f310351',
      diffHunkId: null,
      severity: 'error',
      category: 'bug',
      title: 'Crash',
      body: 'Rationale',
      rationale: 'Rationale',
      filePath: 'src/a.ts',
      line: 2,
      lineEnd: 2,
      confidence: 0.9,
      suggestedFix: 'Guard it.',
      shouldPost: true,
      gitlabPosition: { baseSha: 'base', startSha: 'start', headSha: 'head', oldPath: 'src/a.ts', newPath: 'src/a.ts', newLine: 2 },
      gitlabDiscussionId: null,
      gitlabNoteId: null,
      postedAt: null,
      status: 'open',
      createdAt: '2026-01-01T00:00:00.000Z'
    }).category).toBe('bug');
  });
});
