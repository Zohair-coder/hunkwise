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

  it('rejects empty updates', () => {
    expect(updateGitLabInstanceSchema.safeParse({}).success).toBe(false);
  });

  it('requires a valid MR submission', () => {
    expect(submitReviewSchema.safeParse({ instanceId: 'not-an-id', mergeRequestUrl: 'gitlab/project/1' }).success).toBe(false);
  });
});
