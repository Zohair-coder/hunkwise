import process from 'node:process';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type {
  ChatMessage,
  Comment,
  DiffFile,
  DiffHunk,
  Discussion,
  Finding,
  GitLabInstance,
  Pagination,
  ReviewDetail,
  ReviewList,
  ReviewRun
} from '@hunkwise/contracts';
export { databaseSslModes, parseDatabaseSslMode, postgresSsl, type DatabaseSslMode } from './ssl.js';

export type EncryptedSecret = string & { readonly __encryptedSecret: unique symbol };

export interface SecretCipher {
  encrypt(plaintext: string): EncryptedSecret;
  decrypt(ciphertext: EncryptedSecret): string;
}

export interface NewInstanceRecord {
  name: string;
  baseUrl: string;
  encryptedAccessToken: EncryptedSecret;
}

export interface UpdateInstanceRecord {
  name?: string;
  baseUrl?: string;
  encryptedAccessToken?: EncryptedSecret;
}

export interface HunkwiseStore {
  ping(): Promise<void>;
  close(): Promise<void>;
  listInstances(): Promise<GitLabInstance[]>;
  getInstance(id: string): Promise<GitLabInstance | null>;
  createInstance(input: NewInstanceRecord): Promise<GitLabInstance>;
  updateInstance(id: string, input: UpdateInstanceRecord): Promise<GitLabInstance | null>;
  deleteInstance(id: string): Promise<boolean>;
  listReviews(page: Pagination): Promise<ReviewList>;
  getReview(id: string): Promise<ReviewDetail | null>;
}

/** Capability intentionally kept separate from public instance DTO access. */
export interface InstanceSecretStore {
  getEncryptedInstanceAccessToken(instanceId: string): Promise<EncryptedSecret | null>;
}

interface InstanceRow {
  id: string;
  name: string;
  base_url: string;
  access_token_ciphertext: string;
  created_at: Date;
  updated_at: Date;
}

interface ReviewRow {
  id: string;
  merge_request_id: string;
  status: ReviewRun['status'];
  source_sha: string;
  summary: string | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface DiffFileRow { id: string; review_run_id: string; old_path: string | null; new_path: string; status: DiffFile['status']; additions: number; deletions: number }
interface DiffHunkRow { id: string; diff_file_id: string; old_start: number; old_lines: number; new_start: number; new_lines: number; header: string; patch: string; position: number }
interface FindingRow { id: string; review_run_id: string; diff_hunk_id: string | null; severity: Finding['severity']; category: string; title: string; body: string; file_path: string; line: number | null; confidence: string; status: Finding['status']; created_at: Date }
interface DiscussionRow { id: string; review_run_id: string; finding_id: string | null; gitlab_discussion_id: string | null; resolved: boolean; created_at: Date }
interface CommentRow { id: string; discussion_id: string; author_type: Comment['authorType']; author_name: string; body: string; gitlab_note_id: string | null; created_at: Date }
interface ChatMessageRow { id: string; review_run_id: string; role: ChatMessage['role']; content: string; created_at: Date }

const iso = (value: Date): string => value.toISOString();
const mapInstance = (row: InstanceRow): GitLabInstance => ({
  id: row.id,
  name: row.name,
  baseUrl: row.base_url,
  hasAccessToken: row.access_token_ciphertext.length > 0,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const mapReview = (row: ReviewRow): ReviewRun => ({
  id: row.id,
  mergeRequestId: row.merge_request_id,
  status: row.status,
  sourceSha: row.source_sha,
  summary: row.summary,
  errorMessage: row.error_message,
  startedAt: row.started_at ? iso(row.started_at) : null,
  completedAt: row.completed_at ? iso(row.completed_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const mapDiffFile = (row: DiffFileRow): DiffFile => ({ id: row.id, reviewRunId: row.review_run_id, oldPath: row.old_path, newPath: row.new_path, status: row.status, additions: row.additions, deletions: row.deletions });
const mapDiffHunk = (row: DiffHunkRow): DiffHunk => ({ id: row.id, diffFileId: row.diff_file_id, oldStart: row.old_start, oldLines: row.old_lines, newStart: row.new_start, newLines: row.new_lines, header: row.header, patch: row.patch, position: row.position });
const mapFinding = (row: FindingRow): Finding => ({ id: row.id, reviewRunId: row.review_run_id, diffHunkId: row.diff_hunk_id, severity: row.severity, category: row.category, title: row.title, body: row.body, filePath: row.file_path, line: row.line, confidence: Number(row.confidence), status: row.status, createdAt: iso(row.created_at) });
const mapDiscussion = (row: DiscussionRow): Discussion => ({ id: row.id, reviewRunId: row.review_run_id, findingId: row.finding_id, gitlabDiscussionId: row.gitlab_discussion_id, resolved: row.resolved, createdAt: iso(row.created_at) });
const mapComment = (row: CommentRow): Comment => ({ id: row.id, discussionId: row.discussion_id, authorType: row.author_type, authorName: row.author_name, body: row.body, gitlabNoteId: row.gitlab_note_id, createdAt: iso(row.created_at) });
const mapChatMessage = (row: ChatMessageRow): ChatMessage => ({ id: row.id, reviewRunId: row.review_run_id, role: row.role, content: row.content, createdAt: iso(row.created_at) });

const rollback = async (client: PoolClient): Promise<void> => {
  await client.query('ROLLBACK').catch(() => undefined);
};

export class PostgresStore implements HunkwiseStore, InstanceSecretStore {
  readonly #pool: Pool;
  readonly #poolErrorHandler: (error: Error) => void;

  constructor(config: PoolConfig | Pool, onPoolError: (error: Error) => void = (error) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'postgres_pool_error', message: error.message })}\n`);
  }) {
    this.#pool = config instanceof Pool ? config : new Pool(config);
    this.#poolErrorHandler = onPoolError;
    this.#pool.on('error', this.#poolErrorHandler);
  }

  async ping(): Promise<void> {
    await this.#pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.#pool.end();
    this.#pool.removeListener('error', this.#poolErrorHandler);
  }

  async listInstances(): Promise<GitLabInstance[]> {
    const result = await this.#pool.query<InstanceRow>(
      'SELECT id, name, base_url, access_token_ciphertext, created_at, updated_at FROM gitlab_instances ORDER BY name'
    );
    return result.rows.map(mapInstance);
  }

  async getInstance(id: string): Promise<GitLabInstance | null> {
    const result = await this.#pool.query<InstanceRow>(
      'SELECT id, name, base_url, access_token_ciphertext, created_at, updated_at FROM gitlab_instances WHERE id = $1',
      [id]
    );
    return result.rows[0] ? mapInstance(result.rows[0]) : null;
  }

  async getEncryptedInstanceAccessToken(instanceId: string): Promise<EncryptedSecret | null> {
    const result = await this.#pool.query<{ access_token_ciphertext: string }>(
      'SELECT access_token_ciphertext FROM gitlab_instances WHERE id = $1',
      [instanceId]
    );
    const value = result.rows[0]?.access_token_ciphertext;
    return value ? value as EncryptedSecret : null;
  }

  async createInstance(input: NewInstanceRecord): Promise<GitLabInstance> {
    const result = await this.#pool.query<InstanceRow>(
      `INSERT INTO gitlab_instances (name, base_url, access_token_ciphertext)
       VALUES ($1, $2, $3)
       RETURNING id, name, base_url, access_token_ciphertext, created_at, updated_at`,
      [input.name, input.baseUrl, input.encryptedAccessToken]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Instance insert returned no row');
    return mapInstance(row);
  }

  async updateInstance(id: string, input: UpdateInstanceRecord): Promise<GitLabInstance | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (input.name !== undefined) add('name', input.name);
    if (input.baseUrl !== undefined) add('base_url', input.baseUrl);
    if (input.encryptedAccessToken !== undefined) add('access_token_ciphertext', input.encryptedAccessToken);
    if (fields.length === 0) return this.getInstance(id);
    values.push(id);
    const result = await this.#pool.query<InstanceRow>(
      `UPDATE gitlab_instances SET ${fields.join(', ')}, updated_at = now()
       WHERE id = $${values.length}
       RETURNING id, name, base_url, access_token_ciphertext, created_at, updated_at`,
      values
    );
    return result.rows[0] ? mapInstance(result.rows[0]) : null;
  }

  async deleteInstance(id: string): Promise<boolean> {
    const result = await this.#pool.query('DELETE FROM gitlab_instances WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async listReviews(page: Pagination): Promise<ReviewList> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const count = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM review_runs');
      const rows = await client.query<ReviewRow>(
        `SELECT id, merge_request_id, status, source_sha, summary, error_message,
                started_at, completed_at, created_at, updated_at
         FROM review_runs ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
        [page.limit, page.offset]
      );
      await client.query('COMMIT');
      return { items: rows.rows.map(mapReview), total: Number(count.rows[0]?.count ?? 0), limit: page.limit, offset: page.offset };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getReview(id: string): Promise<ReviewDetail | null> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const runResult = await client.query<ReviewRow>(
        `SELECT id, merge_request_id, status, source_sha, summary, error_message,
                started_at, completed_at, created_at, updated_at
         FROM review_runs WHERE id = $1`, [id]
      );
      const run = runResult.rows[0];
      if (!run) {
        await client.query('COMMIT');
        return null;
      }
      const files = await client.query<DiffFileRow>('SELECT id, review_run_id, old_path, new_path, status, additions, deletions FROM diff_files WHERE review_run_id = $1 ORDER BY new_path, id', [id]);
      const hunks = await client.query<DiffHunkRow>('SELECT h.id, h.diff_file_id, h.old_start, h.old_lines, h.new_start, h.new_lines, h.header, h.patch, h.position FROM diff_hunks h JOIN diff_files f ON f.id = h.diff_file_id WHERE f.review_run_id = $1 ORDER BY f.new_path, h.position, h.id', [id]);
      const findings = await client.query<FindingRow>('SELECT id, review_run_id, diff_hunk_id, severity, category, title, body, file_path, line, confidence::text, status, created_at FROM findings WHERE review_run_id = $1 ORDER BY created_at, id', [id]);
      const discussions = await client.query<DiscussionRow>('SELECT id, review_run_id, finding_id, gitlab_discussion_id, resolved, created_at FROM discussions WHERE review_run_id = $1 ORDER BY created_at, id', [id]);
      const comments = await client.query<CommentRow>('SELECT c.id, c.discussion_id, c.author_type, c.author_name, c.body, c.gitlab_note_id, c.created_at FROM comments c JOIN discussions d ON d.id = c.discussion_id WHERE d.review_run_id = $1 ORDER BY c.created_at, c.id', [id]);
      const chatMessages = await client.query<ChatMessageRow>('SELECT id, review_run_id, role, content, created_at FROM chat_messages WHERE review_run_id = $1 ORDER BY created_at, id', [id]);
      await client.query('COMMIT');
      return { run: mapReview(run), files: files.rows.map(mapDiffFile), hunks: hunks.rows.map(mapDiffHunk), findings: findings.rows.map(mapFinding), discussions: discussions.rows.map(mapDiscussion), comments: comments.rows.map(mapComment), chatMessages: chatMessages.rows.map(mapChatMessage) };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
