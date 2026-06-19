import { describe, expect, it } from 'vitest';
import {
  createDiffDiscussionSchema,
  createGitLabInstanceSchema,
  gitLabDiscussionActionResponseSchema,
  gitLabWebhookResponseSchema,
  reviewRunReferenceSchema,
  submitReviewSchema,
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
  });

  it('validates Slice 2 response and discussion contracts', () => {
    expect(reviewRunReferenceSchema.parse({
      runId: '05b6f6a5-1ac5-4499-a7dd-f2fd0f310351',
      status: 'completed',
      summary: 'GitLab ingestion complete; AI review pending Slice 3'
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
});
