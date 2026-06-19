import { describe, expect, it } from 'vitest';
import { createGitLabInstanceSchema, submitReviewSchema, updateGitLabInstanceSchema } from '../src/index.js';

describe('API contracts', () => {
  it('normalizes instance URLs', () => {
    const value = createGitLabInstanceSchema.parse({ name: 'Work', baseUrl: 'https://gitlab.example.com/', accessToken: 'secret' });
    expect(value.baseUrl).toBe('https://gitlab.example.com');
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
});
