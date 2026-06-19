import { describe, expect, it } from 'vitest';
import {
  assertIngestedReview,
  GitLabCeE2eConfigError,
  parseGitLabCeE2eArgs,
  redactGitLabCeE2eText,
  selectPostableFindingIds,
  summarizePostedDiscussions,
  summarizeReviewDetail,
  validateGitLabCeE2eEnvironment
} from '../src/gitlab-ce-e2e-harness.js';

const reviewDetail = {
  run: {
    id: 'run-1',
    status: 'completed',
    mergeRequest: { title: 'Review math helper changes' }
  },
  files: [{ id: 'file-1' }],
  hunks: [{ id: 'hunk-1' }],
  discussions: [{ id: 'discussion-1' }],
  comments: [{ id: 'comment-1' }],
  findings: [
    { id: 'finding-1', shouldPost: true, gitlabPosition: { newLine: 11 } },
    { id: 'finding-2', shouldPost: true, gitlabPosition: null },
    { id: 'finding-3', shouldPost: false, gitlabPosition: { newLine: 7 } }
  ]
};

describe('GitLab CE E2E harness helpers', () => {
  it('parses configurable ports, project names, and boolean flags', () => {
    expect(parseGitLabCeE2eArgs([
      '--project-name', 'hunkwise-slice5',
      '--gitlab-http-port=18088',
      '--gitlab-ssh-port', '12224',
      '--app-port', '13000',
      '--timeout-ms', '1000',
      '--project-slug', 'slice-5',
      '--keep',
      '--no-build'
    ])).toMatchObject({
      projectName: 'hunkwise-slice5',
      gitlabHttpPort: 18088,
      gitlabSshPort: 12224,
      appPort: 13000,
      timeoutMs: 1000,
      projectSlug: 'slice-5',
      keep: true,
      noBuild: true
    });
  });

  it('rejects unsafe argument combinations and invalid values', () => {
    expect(() => parseGitLabCeE2eArgs(['--cleanup', '--keep'])).toThrow(GitLabCeE2eConfigError);
    expect(() => parseGitLabCeE2eArgs(['--app-port', '70000'])).toThrow(GitLabCeE2eConfigError);
    expect(() => parseGitLabCeE2eArgs(['--project-slug', 'Bad/Slug'])).toThrow(GitLabCeE2eConfigError);
  });

  it('requires OpenAI only for the real run path', () => {
    expect(validateGitLabCeE2eEnvironment({}, { cleanup: false })).toEqual(['OPENAI_API_KEY']);
    expect(validateGitLabCeE2eEnvironment({}, { cleanup: true })).toEqual([]);
    expect(validateGitLabCeE2eEnvironment({ OPENAI_API_KEY: 'sk-live-secret' }, { cleanup: false })).toEqual([]);
  });

  it('redacts OpenAI keys, GitLab tokens, URLs, and explicit runtime secrets', () => {
    const text = [
      'OPENAI_API_KEY=sk-secret123456789',
      'PRIVATE_TOKEN=glpat-secret-token',
      'postgres://hunkwise:password@postgres:5432/hunkwise',
      'http://gitlab?private_token=glpat-other',
      'runtime-value'
    ].join('\n');
    const redacted = redactGitLabCeE2eText(text, ['runtime-value']);
    expect(redacted).not.toContain('sk-secret123456789');
    expect(redacted).not.toContain('glpat-secret-token');
    expect(redacted).not.toContain('password@postgres');
    expect(redacted).not.toContain('runtime-value');
    expect(redacted).toContain('[redacted]');
  });

  it('summarizes and validates persisted review detail shape', () => {
    expect(summarizeReviewDetail(reviewDetail)).toEqual({
      runId: 'run-1',
      status: 'completed',
      mergeRequestTitle: 'Review math helper changes',
      files: 1,
      hunks: 1,
      discussions: 1,
      comments: 1,
      findings: 3,
      postableFindings: 1
    });
    expect(assertIngestedReview(reviewDetail).hunks).toBe(1);
  });

  it('selects only grounded postable findings', () => {
    expect(selectPostableFindingIds(reviewDetail, 2)).toEqual(['finding-1']);
  });

  it('reports missing posted GitLab discussion ids from API responses', () => {
    expect(summarizePostedDiscussions([{ id: 'discussion-a' }, { id: 'discussion-b' }], ['discussion-b', 'discussion-c'])).toEqual({
      found: 1,
      missing: ['discussion-c']
    });
  });
});
