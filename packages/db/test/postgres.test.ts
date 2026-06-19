import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncryptedSecret } from '../src/index.js';
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
  const mr = await pool.query<{ id: string }>("INSERT INTO merge_requests (project_id, gitlab_iid, title, author_username, source_branch, target_branch, source_sha, target_sha, state, web_url) VALUES ($1, 1, 'MR', 'author', 'feature', 'main', 'source', 'target', 'open', 'https://gitlab.test/group/project/-/merge_requests/1') RETURNING id", [project.rows[0]?.id]);
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
      '004_case_insensitive_gitlab_base_url.sql'
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
