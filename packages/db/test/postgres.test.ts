import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncryptedSecret, GitLabReviewSnapshot } from '../src/index.js';
import { PostgresStore } from '../src/index.js';
import { migrate } from '../src/migrate.js';

const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
let container: StartedPostgreSqlContainer;
let pool: Pool;
let store: PostgresStore;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  await migrate(container.getConnectionUri(), migrationsDirectory);
  pool = new Pool({ connectionString: container.getConnectionUri() });
  store = new PostgresStore(pool, vi.fn());
}, 120_000);

afterAll(async () => {
  await store?.close();
  await container?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query('TRUNCATE gitlab_instances CASCADE');
});

async function createRuns(): Promise<{ first: string; second: string; firstHunk: string; secondHunk: string }> {
  const instance = await pool.query<{ id: string }>("INSERT INTO gitlab_instances (name, base_url, access_token_ciphertext) VALUES ('Test', 'https://gitlab.test', 'v1:ciphertext') RETURNING id");
  const project = await pool.query<{ id: string }>("INSERT INTO projects (instance_id, gitlab_id, path_with_namespace, web_url) VALUES ($1, 1, 'group/project', 'https://gitlab.test/group/project') RETURNING id", [instance.rows[0]?.id]);
  const mr = await pool.query<{ id: string }>("INSERT INTO merge_requests (project_id, gitlab_iid, title, author_username, source_branch, target_branch, source_sha, target_sha, start_sha, state, web_url) VALUES ($1, 1, 'MR', 'author', 'feature', 'main', 'source', 'target', 'start', 'open', 'https://gitlab.test/group/project/-/merge_requests/1') RETURNING id", [project.rows[0]?.id]);
  const run1 = await pool.query<{ id: string }>("INSERT INTO review_runs (merge_request_id, status, source_sha, created_at) VALUES ($1, 'completed', 'source-1', '2026-01-01T00:00:00Z') RETURNING id", [mr.rows[0]?.id]);
  const run2 = await pool.query<{ id: string }>("INSERT INTO review_runs (merge_request_id, status, source_sha, created_at) VALUES ($1, 'completed', 'source-2', '2026-01-01T00:00:00Z') RETURNING id", [mr.rows[0]?.id]);
  const file1 = await pool.query<{ id: string }>("INSERT INTO diff_files (review_run_id, new_path, status, additions, deletions) VALUES ($1, 'one.ts', 'modified', 1, 0) RETURNING id", [run1.rows[0]?.id]);
  const file2 = await pool.query<{ id: string }>("INSERT INTO diff_files (review_run_id, new_path, status, additions, deletions) VALUES ($1, 'two.ts', 'modified', 1, 0) RETURNING id", [run2.rows[0]?.id]);
  const hunk1 = await pool.query<{ id: string }>("INSERT INTO diff_hunks (diff_file_id, review_run_id, old_start, old_lines, new_start, new_lines, header, patch, position) VALUES ($1, $2, 1, 1, 1, 1, '@@ one', '+one', 0) RETURNING id", [file1.rows[0]?.id, run1.rows[0]?.id]);
  const hunk2 = await pool.query<{ id: string }>("INSERT INTO diff_hunks (diff_file_id, review_run_id, old_start, old_lines, new_start, new_lines, header, patch, position) VALUES ($1, $2, 1, 1, 1, 1, '@@ two', '+two', 0) RETURNING id", [file2.rows[0]?.id, run2.rows[0]?.id]);
  return { first: run1.rows[0]!.id, second: run2.rows[0]!.id, firstHunk: hunk1.rows[0]!.id, secondHunk: hunk2.rows[0]!.id };
}

describe('PostgreSQL persistence', () => {
  it('applies migrations idempotently and records checksums', async () => {
    await migrate(container.getConnectionUri(), migrationsDirectory);
    const result = await pool.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations ORDER BY name');
    expect(result.rows.map((row) => row.name)).toEqual([
      '001_foundation.sql',
      '002_review_ownership_integrity.sql',
      '003_gitlab_base_url_shape.sql',
      '004_case_insensitive_gitlab_base_url.sql',
      '005_gitlab_webhook_events.sql',
      '006_gitlab_webhook_processing_state.sql',
      '007_ai_review_results.sql',
      '008_merge_request_start_sha.sql'
    ]);
    expect(result.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
  });

  it('keeps encrypted credential retrieval separate from public DTOs', async () => {
    const encrypted = 'v1:encrypted-only' as EncryptedSecret;
    const instance = await store.createInstance({ name: 'Secure', baseUrl: 'https://secure.gitlab.test', encryptedAccessToken: encrypted });
    expect(instance).not.toHaveProperty('accessToken');
    expect(await store.getEncryptedInstanceAccessToken(instance.id)).toBe(encrypted);
  });

  it('rejects base URL userinfo at the database boundary', async () => {
    await expect(pool.query("INSERT INTO gitlab_instances (name, base_url, access_token_ciphertext) VALUES ('Unsafe', 'https://user:password@gitlab.test', 'v1:ciphertext')"))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('rejects base URL query strings and fragments at the database boundary', async () => {
    await expect(pool.query("INSERT INTO gitlab_instances (name, base_url, access_token_ciphertext) VALUES ('Query', 'https://gitlab.test/group?private_token=secret', 'v1:ciphertext')"))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("INSERT INTO gitlab_instances (name, base_url, access_token_ciphertext) VALUES ('Fragment', 'https://gitlab.test/group#access_token=secret', 'v1:ciphertext')"))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('accepts uppercase HTTP and HTTPS schemes at the database boundary', async () => {
    const https = await pool.query<{ base_url: string }>("INSERT INTO gitlab_instances (name, base_url, access_token_ciphertext) VALUES ('Upper HTTPS', 'HTTPS://gitlab-uppercase.test/team', 'v1:ciphertext') RETURNING base_url");
    const http = await pool.query<{ base_url: string }>("INSERT INTO gitlab_instances (name, base_url, access_token_ciphertext) VALUES ('Upper HTTP', 'HTTP://gitlab-http-uppercase.test/team', 'v1:ciphertext') RETURNING base_url");
    expect(https.rows[0]?.base_url).toBe('HTTPS://gitlab-uppercase.test/team');
    expect(http.rows[0]?.base_url).toBe('HTTP://gitlab-http-uppercase.test/team');
  });

  it('uses stable tie-break ordering and returns persisted review detail', async () => {
    const runs = await createRuns();
    const page = await store.listReviews({ limit: 20, offset: 0 });
    expect(page.items.map((run) => run.id)).toEqual([runs.first, runs.second].sort().reverse());
    const detail = await store.getReview(runs.first);
    expect(detail?.run.id).toBe(runs.first);
    expect(detail?.files.map((file) => file.newPath)).toEqual(['one.ts']);
    expect(detail?.hunks.map((hunk) => hunk.patch)).toEqual(['+one']);
  });

  it('upserts GitLab review snapshots idempotently for the same MR SHA', async () => {
    const instance = await store.createInstance({ name: 'GitLab', baseUrl: 'https://gitlab.snapshot.test', encryptedAccessToken: 'v1:ciphertext' as EncryptedSecret });
    const snapshot: GitLabReviewSnapshot = {
      instanceId: instance.id,
      project: { gitlabId: 123, pathWithNamespace: 'group/project', defaultBranch: 'main', webUrl: 'https://gitlab.snapshot.test/group/project' },
      mergeRequest: {
        gitlabIid: 7,
        title: 'MR',
        authorUsername: 'alice',
        sourceBranch: 'feature',
        targetBranch: 'main',
        sourceSha: 'head-sha',
        targetSha: 'base-sha',
        startSha: 'start-sha',
        state: 'open',
        webUrl: 'https://gitlab.snapshot.test/group/project/-/merge_requests/7'
      },
      files: [{
        oldPath: 'a.ts',
        newPath: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '@@ -1 +1 @@', patch: '@@ -1 +1 @@\n-old\n+new', position: 0 }]
      }],
      discussions: [{
        gitlabDiscussionId: 'discussion-1',
        resolved: false,
        comments: [{ authorType: 'gitlab', authorName: 'bob', body: 'Existing', gitlabNoteId: 'note-1', createdAt: '2026-01-01T00:00:00Z' }]
      }],
      summary: 'GitLab ingestion complete'
    };

    const first = await store.upsertGitLabReviewSnapshot(snapshot);
    const second = await store.upsertGitLabReviewSnapshot({
      ...snapshot,
      discussions: [{
        ...snapshot.discussions[0]!,
        comments: [
          ...snapshot.discussions[0]!.comments,
          { authorType: 'gitlab', authorName: 'carol', body: 'Follow-up', gitlabNoteId: 'note-2', createdAt: '2026-01-01T00:01:00Z' }
        ]
      }]
    });
    expect(second.runId).toBe(first.runId);
    const runs = await store.listReviews({ limit: 20, offset: 0 });
    expect(runs.total).toBe(1);
    const detail = await store.getReview(first.runId);
    expect(detail?.files).toMatchObject([{ newPath: 'a.ts', additions: 1, deletions: 1 }]);
    expect(detail?.hunks).toMatchObject([{ header: '@@ -1 +1 @@', position: 0 }]);
    expect(detail?.discussions).toMatchObject([{ gitlabDiscussionId: 'discussion-1', resolved: false }]);
    expect(detail?.comments).toMatchObject([{ body: 'Existing', gitlabNoteId: 'note-1' }, { body: 'Follow-up', gitlabNoteId: 'note-2' }]);
    expect(await store.getReviewContext(first.runId)).toMatchObject({ targetSha: 'base-sha', startSha: 'start-sha' });

    await store.failAiReview(first.runId, new Error('invalid model output'));
    const afterFailedAi = await store.upsertGitLabReviewSnapshot(snapshot);
    expect(afterFailedAi).toMatchObject({ runId: first.runId, status: 'completed', summary: 'GitLab ingestion complete' });
    expect((await store.listReviews({ limit: 20, offset: 0 })).total).toBe(1);
  });

  it('persists structured AI findings and records idempotent GitLab posting state', async () => {
    const instance = await store.createInstance({ name: 'AI GitLab', baseUrl: 'https://gitlab.ai.test', encryptedAccessToken: 'v1:ciphertext' as EncryptedSecret });
    const snapshot: GitLabReviewSnapshot = {
      instanceId: instance.id,
      project: { gitlabId: 123, pathWithNamespace: 'group/project', defaultBranch: 'main', webUrl: 'https://gitlab.ai.test/group/project' },
      mergeRequest: {
        gitlabIid: 7,
        title: 'MR',
        authorUsername: 'alice',
        sourceBranch: 'feature',
        targetBranch: 'main',
        sourceSha: 'head-sha',
        targetSha: 'base-sha',
        startSha: 'start-sha',
        state: 'open',
        webUrl: 'https://gitlab.ai.test/group/project/-/merge_requests/7'
      },
      files: [{
        oldPath: 'a.ts',
        newPath: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, header: '@@ -1 +1,2 @@', patch: '@@ -1 +1,2 @@\n const x = 1;\n+throw new Error()', position: 0 }]
      }],
      discussions: [],
      summary: 'GitLab ingestion complete'
    };
    const run = await store.upsertGitLabReviewSnapshot(snapshot);
    const hunkId = (await store.getReview(run.runId))!.hunks[0]!.id;

    await store.startAiReview(run.runId);
    await store.completeAiReview({
      reviewRunId: run.runId,
      model: 'gpt-test',
      summary: 'One issue found',
      overviewCommentBody: 'Overview body',
      findings: [{
        aiFindingKey: 'stable-key',
        diffHunkId: hunkId,
        severity: 'error',
        category: 'bug',
        title: 'Unexpected throw',
        rationale: 'The parser throws.',
        filePath: 'a.ts',
        line: 2,
        lineEnd: 2,
        confidence: 0.9,
        suggestedFix: 'Return an error value.',
        shouldPost: true,
        gitlabPosition: { baseSha: 'base-sha', startSha: 'base-sha', headSha: 'head-sha', oldPath: 'a.ts', newPath: 'a.ts', positionType: 'text', newLine: 2 }
      }]
    });
    const detail = await store.getReview(run.runId);
    expect(detail?.run).toMatchObject({ status: 'completed', aiModel: 'gpt-test', overviewCommentBody: 'Overview body' });
    expect(detail?.findings).toMatchObject([{ category: 'bug', suggestedFix: 'Return an error value.', shouldPost: true, gitlabPosition: { newLine: 2 } }]);

    const findingId = detail!.findings[0]!.id;
    await store.recordAiFindingPosted({ reviewRunId: run.runId, findingId, gitlabDiscussionId: 'discussion-1', gitlabNoteId: 'note-1' });
    await store.recordAiFindingPosted({ reviewRunId: run.runId, findingId, gitlabDiscussionId: 'discussion-1', gitlabNoteId: 'note-1' });
    await store.recordAiOverviewPosted({ reviewRunId: run.runId, gitlabDiscussionId: 'overview-1', gitlabNoteId: 'overview-note-1', body: 'Overview body' });
    await store.recordAiOverviewPosted({ reviewRunId: run.runId, gitlabDiscussionId: 'overview-1', gitlabNoteId: 'overview-note-1', body: 'Overview body' });
    expect(await store.getAiOverviewPost(run.runId)).toEqual({ gitlabDiscussionId: 'overview-1', gitlabNoteId: 'overview-note-1' });

    const posted = await store.getReview(run.runId);
    expect(posted?.findings[0]).toMatchObject({ gitlabDiscussionId: 'discussion-1', gitlabNoteId: 'note-1' });
    expect(posted?.discussions.filter((discussion) => discussion.gitlabDiscussionId === 'discussion-1')).toHaveLength(1);
    expect(posted?.discussions.filter((discussion) => discussion.gitlabDiscussionId === 'overview-1')).toHaveLength(1);
    expect(posted?.comments.filter((comment) => comment.gitlabNoteId === 'note-1')).toHaveLength(1);
    expect(posted?.comments.filter((comment) => comment.gitlabNoteId === 'overview-note-1')).toHaveLength(1);

    await store.failAiReview(run.runId, new Error('DATABASE_URL=postgres://user:pass@db/hunkwise APP_ENCRYPTION_KEY=super-secret v1:aaa:bbb:ccc'));
    const failed = await store.getReview(run.runId);
    expect(failed?.run.errorMessage).not.toContain('user:pass');
    expect(failed?.run.errorMessage).not.toContain('super-secret');
    expect(failed?.run.errorMessage).not.toContain('v1:aaa:bbb:ccc');
  });

  it('retries failed webhook events and suppresses only completed duplicates', async () => {
    const instance = await store.createInstance({ name: 'GitLab', baseUrl: 'https://gitlab.webhook.test', encryptedAccessToken: 'v1:ciphertext' as EncryptedSecret });
    const first = await store.recordGitLabWebhook({ instanceId: instance.id, eventKey: 'event-1', eventType: 'Merge Request Hook', payload: { object_kind: 'merge_request' } });
    const inProgress = await store.recordGitLabWebhook({ instanceId: instance.id, eventKey: 'event-1', eventType: 'Merge Request Hook', payload: { object_kind: 'merge_request' } });
    expect(first).toMatchObject({ duplicate: false, state: 'claimed' });
    expect(inProgress).toMatchObject({ duplicate: true, state: 'in_progress', eventId: first.eventId });

    await store.failGitLabWebhook(first.eventId, new Error('GitLab outage'));
    const retry = await store.recordGitLabWebhook({ instanceId: instance.id, eventKey: 'event-1', eventType: 'Merge Request Hook', payload: { object_kind: 'merge_request', retry: true } });
    expect(retry).toMatchObject({ duplicate: false, state: 'claimed', eventId: first.eventId });

    await store.completeGitLabWebhook(first.eventId, null);
    const completedDuplicate = await store.recordGitLabWebhook({ instanceId: instance.id, eventKey: 'event-1', eventType: 'Merge Request Hook', payload: { object_kind: 'merge_request' } });
    expect(completedDuplicate).toMatchObject({ duplicate: true, state: 'completed_duplicate', eventId: first.eventId });
    const row = await pool.query<{ processed_at: Date | null }>('SELECT processed_at FROM gitlab_webhook_events WHERE id = $1', [first.eventId]);
    expect(row.rows[0]?.processed_at).toBeInstanceOf(Date);
  });

  it('rejects cross-run hunk and finding references', async () => {
    const runs = await createRuns();
    const secondFile = await pool.query<{ id: string }>('SELECT id FROM diff_files WHERE review_run_id = $1', [runs.second]);
    await expect(pool.query(
      "INSERT INTO diff_hunks (diff_file_id, review_run_id, old_start, old_lines, new_start, new_lines, header, patch, position) VALUES ($1, $2, 2, 1, 2, 1, '@@ mismatch', '+bad', 1)",
      [secondFile.rows[0]?.id, runs.first]
    )).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(
      "INSERT INTO findings (review_run_id, diff_hunk_id, severity, category, title, body, file_path, confidence) VALUES ($1, $2, 'error', 'security', 'Mismatch', 'Body', 'two.ts', 1)",
      [runs.first, runs.secondHunk]
    )).rejects.toMatchObject({ code: '23503' });
    const finding = await pool.query<{ id: string }>(
      "INSERT INTO findings (review_run_id, diff_hunk_id, severity, category, title, body, file_path, confidence) VALUES ($1, $2, 'error', 'security', 'Valid', 'Body', 'one.ts', 1) RETURNING id",
      [runs.first, runs.firstHunk]
    );
    await expect(pool.query(
      'INSERT INTO discussions (review_run_id, finding_id) VALUES ($1, $2)',
      [runs.second, finding.rows[0]?.id]
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('does not leave an unhandled pool error', async () => {
    const handler = vi.fn();
    const isolatedPool = new Pool({ connectionString: container.getConnectionUri() });
    const isolatedStore = new PostgresStore(isolatedPool, handler);
    isolatedPool.emit('error', new Error('connection dropped'));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ message: 'connection dropped' }));
    await isolatedStore.close();
  });

  it('rejects a changed checksum for an applied migration', async () => {
    await pool.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE name = '001_foundation.sql'");
    await expect(migrate(container.getConnectionUri(), migrationsDirectory)).rejects.toThrow('Migration checksum mismatch for 001_foundation.sql');
  });
});
