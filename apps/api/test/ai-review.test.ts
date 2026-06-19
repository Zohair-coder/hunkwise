import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ReviewDetail } from '@hunkwise/contracts';
import type { GitLabReviewContext } from '@hunkwise/db';
import {
  aiReviewResponseFormat,
  buildReviewPrompt,
  gitLabPositionForFinding,
  mapDiffHunkLines,
  parseModelOutput,
  sanitizeForPrompt,
  toFindingRecords
} from '../src/ai-review.js';

const now = new Date().toISOString();
const runId = randomUUID();
const fileId = randomUUID();
const hunkId = randomUUID();
const discussionId = randomUUID();

const context: GitLabReviewContext = {
  reviewRunId: runId,
  instanceId: randomUUID(),
  instanceBaseUrl: 'https://gitlab.example.com',
  projectGitlabId: 12,
  projectPathWithNamespace: 'group/project',
  mergeRequestIid: 7,
  mergeRequestTitle: 'Do not leak OPENAI_API_KEY=sk-should-redact',
  sourceBranch: 'feature',
  targetBranch: 'main',
  sourceSha: 'head-sha',
  targetSha: 'base-sha',
  startSha: 'start-sha',
  mergeRequestUrl: 'https://gitlab.example.com/group/project/-/merge_requests/7'
};

const detail: ReviewDetail = {
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
  files: [{ id: fileId, reviewRunId: runId, oldPath: 'src/a.ts', newPath: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
  hunks: [{
    id: hunkId,
    diffFileId: fileId,
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 4,
    header: '@@ -10,3 +10,4 @@',
    patch: '@@ -10,3 +10,8 @@\n const keep = true;\n-oldSecret(glpat-token1234)\n+newSafe();\n+console.log("sk-secret12345678")\n+APP_ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n+GITLAB_WEBHOOK_SECRET=webhook-secret-value\n+DATABASE_URL=postgres://user:pass@localhost:5432/hunkwise\n+ENCRYPTED=v1:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb:cccccccccccccccc',
    position: 0
  }],
  findings: [],
  discussions: [{ id: discussionId, reviewRunId: runId, findingId: null, gitlabDiscussionId: 'discussion-1', resolved: false, createdAt: now }],
  comments: [{ id: randomUUID(), discussionId, authorType: 'gitlab', authorName: 'bob', body: 'Existing comment with glpat-hidden1234', gitlabNoteId: '1', createdAt: now }],
  chatMessages: []
};

describe('AI review helpers', () => {
  it('requests strict structured JSON output from OpenAI', () => {
    expect(aiReviewResponseFormat).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'hunkwise_ai_review',
        strict: true
      }
    });
    expect(aiReviewResponseFormat.json_schema.schema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['summary', 'overviewCommentBody', 'findings'])
    });
  });

  it('builds a deterministic prompt with truncated sanitized diff context and existing discussions', () => {
    const prompt = buildReviewPrompt(detail, context, { maxPatchCharacters: 70, maxHunksPerFile: 1 });
    expect(prompt.user).toContain('[redacted-openai-key]');
    expect(prompt.user).toContain('[redacted-gitlab-token]');
    expect(prompt.user).not.toContain('sk-secret12345678');
    expect(prompt.user).not.toContain('glpat-token1234');
    expect(prompt.user).not.toContain('webhook-secret-value');
    expect(prompt.user).not.toContain('postgres://user:pass@');
    expect(prompt.user).not.toContain('v1:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb:cccccccccccccccc');
    expect(prompt.user).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=');
    expect(prompt.user).toContain('existingDiscussions');
    expect(prompt.metadata).toMatchObject({ includedFiles: 1, includedHunks: 1, truncatedHunks: 1, maxPatchCharacters: 70 });
  });

  it('validates model output and rejects malformed JSON without exposing secrets', () => {
    const parsed = parseModelOutput(JSON.stringify({
      summary: 'One issue found',
      overviewCommentBody: 'Reviewed the MR.',
      findings: [{
        category: 'bug',
        severity: 'error',
        confidence: 0.91,
        title: 'Null state can crash',
        rationale: 'The branch dereferences a nullable value.',
        filePath: 'src/a.ts',
        line: 12,
        lineEnd: 12,
        suggestedFix: 'Guard the nullable value.',
        shouldPost: true
      }]
    }));
    expect(parsed.findings[0]?.category).toBe('bug');
    expect(() => parseModelOutput('{ "summary": "bad", "api_key": "sk-secret12345678"')).toThrow(/Model output|JSON|Expected/);
    expect(sanitizeForPrompt('OPENAI_API_KEY=sk-secret12345678')).not.toContain('sk-secret12345678');
  });

  it('maps unified diff lines and GitLab positions for inline comments', () => {
    expect(mapDiffHunkLines(detail.hunks[0]!).map((line) => [line.oldLine, line.newLine])).toEqual([
      [10, 10],
      [11, null],
      [null, 11],
      [null, 12],
      [null, 13],
      [null, 14],
      [null, 15],
      [null, 16]
    ]);
    expect(gitLabPositionForFinding(detail, context, 'src/a.ts', 12)).toEqual({
      baseSha: 'base-sha',
      startSha: 'start-sha',
      headSha: 'head-sha',
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      positionType: 'text',
      newLine: 12
    });
    expect(toFindingRecords({
      summary: 'Summary',
      overviewCommentBody: 'Overview',
      findings: [{ category: 'bug', severity: 'warning', confidence: 0.8, title: 'Issue', rationale: 'Why', filePath: 'src/a.ts', line: 12, lineEnd: null, suggestedFix: null, shouldPost: true }]
    }, detail, context)[0]).toMatchObject({ diffHunkId: hunkId, shouldPost: true });
  });
});
