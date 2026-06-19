import process from 'node:process';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { sanitizeSecrets } from '@hunkwise/contracts';
import type {
  ChatMessage,
  Comment,
  DiffFile,
  DiffHunk,
  Discussion,
  Finding,
  MergeRequest,
  GitLabInstance,
  Pagination,
  ReviewDetail,
  ReviewList,
  ReviewRun,
  ReviewRunReference,
  GitLabPosition,
  FindingCategory,
  FindingSeverity
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

export interface GitLabProjectSnapshot {
  gitlabId: number;
  pathWithNamespace: string;
  defaultBranch: string | null;
  webUrl: string;
}

export interface GitLabMergeRequestSnapshot {
  gitlabIid: number;
  title: string;
  authorUsername: string;
  sourceBranch: string;
  targetBranch: string;
  sourceSha: string;
  targetSha: string;
  startSha: string;
  state: 'open' | 'merged' | 'closed';
  webUrl: string;
}

export interface GitLabDiffHunkSnapshot {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  patch: string;
  position: number;
}

export interface GitLabDiffFileSnapshot {
  oldPath: string | null;
  newPath: string;
  status: DiffFile['status'];
  additions: number;
  deletions: number;
  hunks: GitLabDiffHunkSnapshot[];
}

export interface GitLabCommentSnapshot {
  authorType: Comment['authorType'];
  authorName: string;
  body: string;
  gitlabNoteId: string | null;
  createdAt?: string;
}

export interface GitLabDiscussionSnapshot {
  gitlabDiscussionId: string;
  resolved: boolean;
  comments: GitLabCommentSnapshot[];
}

export interface GitLabReviewSnapshot {
  instanceId: string;
  project: GitLabProjectSnapshot;
  mergeRequest: GitLabMergeRequestSnapshot;
  files: GitLabDiffFileSnapshot[];
  discussions: GitLabDiscussionSnapshot[];
  summary: string;
}

export interface GitLabReviewContext {
  reviewRunId: string;
  instanceId: string;
  instanceBaseUrl: string;
  projectGitlabId: number;
  projectPathWithNamespace: string;
  mergeRequestIid: number;
  mergeRequestTitle: string;
  sourceBranch: string;
  targetBranch: string;
  sourceSha: string;
  targetSha: string;
  startSha: string;
  mergeRequestUrl: string;
}

export interface GitLabDiscussionContext extends GitLabReviewContext {
  localDiscussionId: string;
  gitlabDiscussionId: string;
}

export interface RecordGitLabDiscussionInput {
  reviewRunId: string;
  gitlabDiscussionId: string;
  resolved: boolean;
  comment: GitLabCommentSnapshot;
}

export interface RecordGitLabReplyInput {
  localDiscussionId: string;
  authorName: string;
  body: string;
  gitlabNoteId: string | null;
}

export interface RecordGitLabWebhookInput {
  instanceId: string;
  eventKey: string;
  eventType: string;
  payload: unknown;
}

export interface RecordGitLabWebhookResult {
  duplicate: boolean;
  eventId: string;
  state: 'claimed' | 'completed_duplicate' | 'in_progress';
  reviewRunId: string | null;
}

export interface GitLabReviewStore {
  upsertGitLabReviewSnapshot(input: GitLabReviewSnapshot): Promise<ReviewRunReference>;
  getReviewContext(reviewRunId: string): Promise<GitLabReviewContext | null>;
  getDiscussionContext(localDiscussionId: string): Promise<GitLabDiscussionContext | null>;
  recordGitLabDiscussion(input: RecordGitLabDiscussionInput): Promise<{ localDiscussionId: string }>;
  recordGitLabReply(input: RecordGitLabReplyInput): Promise<void>;
  updateGitLabDiscussionResolved(localDiscussionId: string, resolved: boolean): Promise<void>;
  recordGitLabWebhook(input: RecordGitLabWebhookInput): Promise<RecordGitLabWebhookResult>;
  completeGitLabWebhook(eventId: string, reviewRunId: string | null): Promise<void>;
  failGitLabWebhook(eventId: string, error: Error): Promise<void>;
}

export interface AiReviewFindingRecord {
  aiFindingKey: string;
  diffHunkId: string | null;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  rationale: string;
  filePath: string;
  line: number | null;
  lineEnd: number | null;
  confidence: number;
  suggestedFix: string | null;
  shouldPost: boolean;
  gitlabPosition: GitLabPosition | null;
}

export interface CompleteAiReviewInput {
  reviewRunId: string;
  model: string;
  summary: string;
  overviewCommentBody: string;
  findings: AiReviewFindingRecord[];
}

export interface PostAiFindingInput {
  reviewRunId: string;
  findingId: string;
  gitlabDiscussionId: string;
  gitlabNoteId: string | null;
}

export interface RecordAiOverviewPostInput {
  reviewRunId: string;
  gitlabDiscussionId: string;
  gitlabNoteId: string | null;
  body: string;
}

export interface AiOverviewPostRecord {
  gitlabDiscussionId: string;
  gitlabNoteId: string | null;
}

export interface AiReviewStore {
  startAiReview(reviewRunId: string): Promise<void>;
  completeAiReview(input: CompleteAiReviewInput): Promise<void>;
  failAiReview(reviewRunId: string, error: Error): Promise<void>;
  getAiOverviewPost(reviewRunId: string): Promise<AiOverviewPostRecord | null>;
  recordAiFindingPosted(input: PostAiFindingInput): Promise<void>;
  recordAiOverviewPosted(input: RecordAiOverviewPostInput): Promise<void>;
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
  ai_model: string | null;
  overview_comment_body: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MergeRequestRow {
  id: string;
  project_id: string;
  gitlab_iid: number;
  title: string;
  author_username: string;
  source_branch: string;
  target_branch: string;
  source_sha: string;
  target_sha: string;
  state: MergeRequest['state'];
  web_url: string;
  created_at: Date;
  updated_at: Date;
}

interface DiffFileRow { id: string; review_run_id: string; old_path: string | null; new_path: string; status: DiffFile['status']; additions: number; deletions: number }
interface DiffHunkRow { id: string; diff_file_id: string; old_start: number; old_lines: number; new_start: number; new_lines: number; header: string; patch: string; position: number }
interface FindingRow {
  id: string;
  review_run_id: string;
  diff_hunk_id: string | null;
  severity: Finding['severity'];
  category: Finding['category'];
  title: string;
  body: string;
  file_path: string;
  line: number | null;
  line_end: number | null;
  confidence: string;
  suggested_fix: string | null;
  should_post: boolean;
  gitlab_position: GitLabPosition | null;
  gitlab_discussion_id: string | null;
  gitlab_note_id: string | null;
  posted_at: Date | null;
  status: Finding['status'];
  created_at: Date;
}
interface DiscussionRow { id: string; review_run_id: string; finding_id: string | null; gitlab_discussion_id: string | null; resolved: boolean; created_at: Date }
interface CommentRow { id: string; discussion_id: string; author_type: Comment['authorType']; author_name: string; body: string; gitlab_note_id: string | null; created_at: Date }
interface ChatMessageRow { id: string; review_run_id: string; role: ChatMessage['role']; content: string; created_at: Date }
interface ReviewContextRow {
  review_run_id: string;
  instance_id: string;
  instance_base_url: string;
  project_gitlab_id: string;
  project_path_with_namespace: string;
  merge_request_iid: number;
  merge_request_title: string;
  source_branch: string;
  target_branch: string;
  source_sha: string;
  target_sha: string;
  start_sha: string;
  merge_request_url: string;
}
interface DiscussionContextRow extends ReviewContextRow { local_discussion_id: string; gitlab_discussion_id: string }

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
  aiModel: row.ai_model,
  overviewCommentBody: row.overview_comment_body,
  startedAt: row.started_at ? iso(row.started_at) : null,
  completedAt: row.completed_at ? iso(row.completed_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const mapMergeRequest = (row: MergeRequestRow): MergeRequest => ({
  id: row.id,
  projectId: row.project_id,
  gitlabIid: row.gitlab_iid,
  title: row.title,
  authorUsername: row.author_username,
  sourceBranch: row.source_branch,
  targetBranch: row.target_branch,
  sourceSha: row.source_sha,
  targetSha: row.target_sha,
  state: row.state,
  webUrl: row.web_url,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const mapDiffFile = (row: DiffFileRow): DiffFile => ({ id: row.id, reviewRunId: row.review_run_id, oldPath: row.old_path, newPath: row.new_path, status: row.status, additions: row.additions, deletions: row.deletions });
const mapDiffHunk = (row: DiffHunkRow): DiffHunk => ({ id: row.id, diffFileId: row.diff_file_id, oldStart: row.old_start, oldLines: row.old_lines, newStart: row.new_start, newLines: row.new_lines, header: row.header, patch: row.patch, position: row.position });
const mapFinding = (row: FindingRow): Finding => ({
  id: row.id,
  reviewRunId: row.review_run_id,
  diffHunkId: row.diff_hunk_id,
  severity: row.severity,
  category: row.category,
  title: row.title,
  body: row.body,
  rationale: row.body,
  filePath: row.file_path,
  line: row.line,
  lineEnd: row.line_end,
  confidence: Number(row.confidence),
  suggestedFix: row.suggested_fix,
  shouldPost: row.should_post,
  gitlabPosition: row.gitlab_position,
  gitlabDiscussionId: row.gitlab_discussion_id,
  gitlabNoteId: row.gitlab_note_id,
  postedAt: row.posted_at ? iso(row.posted_at) : null,
  status: row.status,
  createdAt: iso(row.created_at)
});
const mapDiscussion = (row: DiscussionRow): Discussion => ({ id: row.id, reviewRunId: row.review_run_id, findingId: row.finding_id, gitlabDiscussionId: row.gitlab_discussion_id, resolved: row.resolved, createdAt: iso(row.created_at) });
const mapComment = (row: CommentRow): Comment => ({ id: row.id, discussionId: row.discussion_id, authorType: row.author_type, authorName: row.author_name, body: row.body, gitlabNoteId: row.gitlab_note_id, createdAt: iso(row.created_at) });
const mapChatMessage = (row: ChatMessageRow): ChatMessage => ({ id: row.id, reviewRunId: row.review_run_id, role: row.role, content: row.content, createdAt: iso(row.created_at) });

const rollback = async (client: PoolClient): Promise<void> => {
  await client.query('ROLLBACK').catch(() => undefined);
};

const sanitizePersistedError = (message: string): string =>
  sanitizeSecrets(message).slice(0, 2000);

export class PostgresStore implements HunkwiseStore, InstanceSecretStore, GitLabReviewStore, AiReviewStore {
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
        `SELECT id, merge_request_id, status, source_sha, summary, error_message, ai_model, overview_comment_body,
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
        `SELECT id, merge_request_id, status, source_sha, summary, error_message, ai_model, overview_comment_body,
                started_at, completed_at, created_at, updated_at
         FROM review_runs WHERE id = $1`, [id]
      );
      const run = runResult.rows[0];
      if (!run) {
        await client.query('COMMIT');
        return null;
      }
      const mergeRequest = await client.query<MergeRequestRow>(
        `SELECT id, project_id, gitlab_iid, title, author_username, source_branch,
                target_branch, source_sha, target_sha, state, web_url, created_at, updated_at
         FROM merge_requests WHERE id = $1`,
        [run.merge_request_id]
      );
      const files = await client.query<DiffFileRow>('SELECT id, review_run_id, old_path, new_path, status, additions, deletions FROM diff_files WHERE review_run_id = $1 ORDER BY new_path, id', [id]);
      const hunks = await client.query<DiffHunkRow>('SELECT h.id, h.diff_file_id, h.old_start, h.old_lines, h.new_start, h.new_lines, h.header, h.patch, h.position FROM diff_hunks h JOIN diff_files f ON f.id = h.diff_file_id WHERE f.review_run_id = $1 ORDER BY f.new_path, h.position, h.id', [id]);
      const findings = await client.query<FindingRow>(
        `SELECT id, review_run_id, diff_hunk_id, severity, category, title, body, file_path, line,
                line_end, confidence::text, suggested_fix, should_post, gitlab_position,
                gitlab_discussion_id, gitlab_note_id, posted_at, status, created_at
         FROM findings WHERE review_run_id = $1 ORDER BY created_at, id`,
        [id]
      );
      const discussions = await client.query<DiscussionRow>('SELECT id, review_run_id, finding_id, gitlab_discussion_id, resolved, created_at FROM discussions WHERE review_run_id = $1 ORDER BY created_at, id', [id]);
      const comments = await client.query<CommentRow>('SELECT c.id, c.discussion_id, c.author_type, c.author_name, c.body, c.gitlab_note_id, c.created_at FROM comments c JOIN discussions d ON d.id = c.discussion_id WHERE d.review_run_id = $1 ORDER BY c.created_at, c.id', [id]);
      const chatMessages = await client.query<ChatMessageRow>('SELECT id, review_run_id, role, content, created_at FROM chat_messages WHERE review_run_id = $1 ORDER BY created_at, id', [id]);
      await client.query('COMMIT');
      return {
        run: { ...mapReview(run), ...(mergeRequest.rows[0] ? { mergeRequest: mapMergeRequest(mergeRequest.rows[0]) } : {}) },
        files: files.rows.map(mapDiffFile),
        hunks: hunks.rows.map(mapDiffHunk),
        findings: findings.rows.map(mapFinding),
        discussions: discussions.rows.map(mapDiscussion),
        comments: comments.rows.map(mapComment),
        chatMessages: chatMessages.rows.map(mapChatMessage)
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertGitLabReviewSnapshot(input: GitLabReviewSnapshot): Promise<ReviewRunReference> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query<{ id: string }>(
        `INSERT INTO projects (instance_id, gitlab_id, path_with_namespace, default_branch, web_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (instance_id, gitlab_id) DO UPDATE
         SET path_with_namespace = EXCLUDED.path_with_namespace,
             default_branch = EXCLUDED.default_branch,
             web_url = EXCLUDED.web_url,
             updated_at = now()
         RETURNING id`,
        [input.instanceId, input.project.gitlabId, input.project.pathWithNamespace, input.project.defaultBranch, input.project.webUrl]
      );
      const projectId = project.rows[0]?.id;
      if (!projectId) throw new Error('Project upsert returned no row');

      const mr = await client.query<{ id: string }>(
        `INSERT INTO merge_requests (project_id, gitlab_iid, title, author_username, source_branch, target_branch, source_sha, target_sha, start_sha, state, web_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (project_id, gitlab_iid) DO UPDATE
         SET title = EXCLUDED.title,
             author_username = EXCLUDED.author_username,
             source_branch = EXCLUDED.source_branch,
             target_branch = EXCLUDED.target_branch,
             source_sha = EXCLUDED.source_sha,
             target_sha = EXCLUDED.target_sha,
             start_sha = EXCLUDED.start_sha,
             state = EXCLUDED.state,
             web_url = EXCLUDED.web_url,
             updated_at = now()
         RETURNING id`,
        [
          projectId,
          input.mergeRequest.gitlabIid,
          input.mergeRequest.title,
          input.mergeRequest.authorUsername,
          input.mergeRequest.sourceBranch,
          input.mergeRequest.targetBranch,
          input.mergeRequest.sourceSha,
          input.mergeRequest.targetSha,
          input.mergeRequest.startSha,
          input.mergeRequest.state,
          input.mergeRequest.webUrl
        ]
      );
      const mergeRequestId = mr.rows[0]?.id;
      if (!mergeRequestId) throw new Error('Merge request upsert returned no row');

      const existing = await client.query<Pick<ReviewRow, 'id' | 'status' | 'summary'>>(
        `SELECT id, status, summary
         FROM review_runs
         WHERE merge_request_id = $1 AND source_sha = $2 AND status <> 'running'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [mergeRequestId, input.mergeRequest.sourceSha]
      );
      const existingRun = existing.rows[0];
      if (existingRun) {
        const refreshed = await client.query<Pick<ReviewRow, 'id' | 'status' | 'summary'>>(
          `UPDATE review_runs
           SET status = 'completed',
               summary = $2,
               error_message = NULL,
               completed_at = now(),
               updated_at = now()
           WHERE id = $1
           RETURNING id, status, summary`,
          [existingRun.id, input.summary]
        );
        for (const discussion of input.discussions) {
          const discussionRow = await client.query<{ id: string }>(
            `INSERT INTO discussions (review_run_id, gitlab_discussion_id, resolved)
             VALUES ($1, $2, $3)
             ON CONFLICT (review_run_id, gitlab_discussion_id) WHERE gitlab_discussion_id IS NOT NULL DO UPDATE
             SET resolved = EXCLUDED.resolved
             RETURNING id`,
            [existingRun.id, discussion.gitlabDiscussionId, discussion.resolved]
          );
          const discussionId = discussionRow.rows[0]?.id;
          if (!discussionId) throw new Error('Discussion insert returned no row');
          for (const comment of discussion.comments) {
            await client.query(
              `INSERT INTO comments (discussion_id, author_type, author_name, body, gitlab_note_id, created_at)
               VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
               ON CONFLICT (discussion_id, gitlab_note_id) WHERE gitlab_note_id IS NOT NULL DO NOTHING`,
              [discussionId, comment.authorType, comment.authorName, comment.body, comment.gitlabNoteId, comment.createdAt ?? null]
            );
          }
        }
        await client.query('COMMIT');
        const row = refreshed.rows[0];
        if (!row) throw new Error('Review run refresh returned no row');
        return { runId: row.id, status: row.status, summary: row.summary };
      }

      const run = await client.query<Pick<ReviewRow, 'id' | 'status' | 'summary'>>(
        `INSERT INTO review_runs (merge_request_id, status, source_sha, summary, started_at)
         VALUES ($1, 'running', $2, $3, now())
         RETURNING id, status, summary`,
        [mergeRequestId, input.mergeRequest.sourceSha, input.summary]
      );
      const runId = run.rows[0]?.id;
      if (!runId) throw new Error('Review run insert returned no row');

      for (const file of input.files) {
        const fileRow = await client.query<{ id: string }>(
          `INSERT INTO diff_files (review_run_id, old_path, new_path, status, additions, deletions)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [runId, file.oldPath, file.newPath, file.status, file.additions, file.deletions]
        );
        const fileId = fileRow.rows[0]?.id;
        if (!fileId) throw new Error('Diff file insert returned no row');
        for (const hunk of file.hunks) {
          await client.query(
            `INSERT INTO diff_hunks (diff_file_id, review_run_id, old_start, old_lines, new_start, new_lines, header, patch, position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [fileId, runId, hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines, hunk.header, hunk.patch, hunk.position]
          );
        }
      }

      for (const discussion of input.discussions) {
        const discussionRow = await client.query<{ id: string }>(
          `INSERT INTO discussions (review_run_id, gitlab_discussion_id, resolved)
           VALUES ($1, $2, $3)
           ON CONFLICT (review_run_id, gitlab_discussion_id) WHERE gitlab_discussion_id IS NOT NULL DO UPDATE
           SET resolved = EXCLUDED.resolved
           RETURNING id`,
          [runId, discussion.gitlabDiscussionId, discussion.resolved]
        );
        const discussionId = discussionRow.rows[0]?.id;
        if (!discussionId) throw new Error('Discussion insert returned no row');
        for (const comment of discussion.comments) {
          await client.query(
            `INSERT INTO comments (discussion_id, author_type, author_name, body, gitlab_note_id, created_at)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
             ON CONFLICT (discussion_id, gitlab_note_id) WHERE gitlab_note_id IS NOT NULL DO NOTHING`,
            [discussionId, comment.authorType, comment.authorName, comment.body, comment.gitlabNoteId, comment.createdAt ?? null]
          );
        }
      }

      const completed = await client.query<Pick<ReviewRow, 'id' | 'status' | 'summary'>>(
        `UPDATE review_runs
         SET status = 'completed', summary = $2, completed_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING id, status, summary`,
        [runId, input.summary]
      );
      await client.query('COMMIT');
      const row = completed.rows[0];
      if (!row) throw new Error('Review run completion returned no row');
      return { runId: row.id, status: row.status, summary: row.summary };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getReviewContext(reviewRunId: string): Promise<GitLabReviewContext | null> {
    const result = await this.#pool.query<ReviewContextRow>(
      `SELECT r.id AS review_run_id,
              gi.id AS instance_id,
              gi.base_url AS instance_base_url,
              p.gitlab_id::text AS project_gitlab_id,
              p.path_with_namespace AS project_path_with_namespace,
              mr.gitlab_iid AS merge_request_iid,
              mr.title AS merge_request_title,
              mr.source_branch,
              mr.target_branch,
              mr.source_sha,
              mr.target_sha,
              mr.start_sha,
              mr.web_url AS merge_request_url
       FROM review_runs r
       JOIN merge_requests mr ON mr.id = r.merge_request_id
       JOIN projects p ON p.id = mr.project_id
       JOIN gitlab_instances gi ON gi.id = p.instance_id
       WHERE r.id = $1`,
      [reviewRunId]
    );
    const row = result.rows[0];
    return row ? {
      reviewRunId: row.review_run_id,
      instanceId: row.instance_id,
      instanceBaseUrl: row.instance_base_url,
      projectGitlabId: Number(row.project_gitlab_id),
      projectPathWithNamespace: row.project_path_with_namespace,
      mergeRequestIid: row.merge_request_iid,
      mergeRequestTitle: row.merge_request_title,
      sourceBranch: row.source_branch,
      targetBranch: row.target_branch,
      sourceSha: row.source_sha,
      targetSha: row.target_sha,
      startSha: row.start_sha,
      mergeRequestUrl: row.merge_request_url
    } : null;
  }

  async getDiscussionContext(localDiscussionId: string): Promise<GitLabDiscussionContext | null> {
    const result = await this.#pool.query<DiscussionContextRow>(
      `SELECT r.id AS review_run_id,
              gi.id AS instance_id,
              gi.base_url AS instance_base_url,
              p.gitlab_id::text AS project_gitlab_id,
              p.path_with_namespace AS project_path_with_namespace,
              mr.gitlab_iid AS merge_request_iid,
              mr.title AS merge_request_title,
              mr.source_branch,
              mr.target_branch,
              mr.source_sha,
              mr.target_sha,
              mr.start_sha,
              mr.web_url AS merge_request_url,
              d.id AS local_discussion_id,
              d.gitlab_discussion_id
       FROM discussions d
       JOIN review_runs r ON r.id = d.review_run_id
       JOIN merge_requests mr ON mr.id = r.merge_request_id
       JOIN projects p ON p.id = mr.project_id
       JOIN gitlab_instances gi ON gi.id = p.instance_id
       WHERE d.id = $1 AND d.gitlab_discussion_id IS NOT NULL`,
      [localDiscussionId]
    );
    const row = result.rows[0];
    return row ? {
      reviewRunId: row.review_run_id,
      instanceId: row.instance_id,
      instanceBaseUrl: row.instance_base_url,
      projectGitlabId: Number(row.project_gitlab_id),
      projectPathWithNamespace: row.project_path_with_namespace,
      mergeRequestIid: row.merge_request_iid,
      mergeRequestTitle: row.merge_request_title,
      sourceBranch: row.source_branch,
      targetBranch: row.target_branch,
      sourceSha: row.source_sha,
      targetSha: row.target_sha,
      startSha: row.start_sha,
      mergeRequestUrl: row.merge_request_url,
      localDiscussionId: row.local_discussion_id,
      gitlabDiscussionId: row.gitlab_discussion_id
    } : null;
  }

  async recordGitLabDiscussion(input: RecordGitLabDiscussionInput): Promise<{ localDiscussionId: string }> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const discussion = await client.query<{ id: string }>(
        `INSERT INTO discussions (review_run_id, gitlab_discussion_id, resolved)
         VALUES ($1, $2, $3)
         ON CONFLICT (review_run_id, gitlab_discussion_id) WHERE gitlab_discussion_id IS NOT NULL DO UPDATE
         SET resolved = EXCLUDED.resolved
         RETURNING id`,
        [input.reviewRunId, input.gitlabDiscussionId, input.resolved]
      );
      const discussionId = discussion.rows[0]?.id;
      if (!discussionId) throw new Error('Discussion insert returned no row');
      await client.query(
        `INSERT INTO comments (discussion_id, author_type, author_name, body, gitlab_note_id, created_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
         ON CONFLICT (discussion_id, gitlab_note_id) WHERE gitlab_note_id IS NOT NULL DO NOTHING`,
        [discussionId, input.comment.authorType, input.comment.authorName, input.comment.body, input.comment.gitlabNoteId, input.comment.createdAt ?? null]
      );
      await client.query('COMMIT');
      return { localDiscussionId: discussionId };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordGitLabReply(input: RecordGitLabReplyInput): Promise<void> {
    await this.#pool.query(
      `INSERT INTO comments (discussion_id, author_type, author_name, body, gitlab_note_id)
       VALUES ($1, 'hunkwise', $2, $3, $4)
       ON CONFLICT (discussion_id, gitlab_note_id) WHERE gitlab_note_id IS NOT NULL DO NOTHING`,
      [input.localDiscussionId, input.authorName, input.body, input.gitlabNoteId]
    );
  }

  async updateGitLabDiscussionResolved(localDiscussionId: string, resolved: boolean): Promise<void> {
    await this.#pool.query('UPDATE discussions SET resolved = $2 WHERE id = $1', [localDiscussionId, resolved]);
  }

  async startAiReview(reviewRunId: string): Promise<void> {
    const result = await this.#pool.query(
      `UPDATE review_runs
       SET status = 'running',
           error_message = NULL,
           started_at = COALESCE(started_at, now()),
           completed_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [reviewRunId]
    );
    if ((result.rowCount ?? 0) === 0) throw new Error('Review run not found');
  }

  async completeAiReview(input: CompleteAiReviewInput): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM findings
         WHERE review_run_id = $1
           AND gitlab_discussion_id IS NULL
           AND id NOT IN (
             SELECT finding_id FROM discussions WHERE review_run_id = $1 AND finding_id IS NOT NULL AND gitlab_discussion_id IS NOT NULL
           )`,
        [input.reviewRunId]
      );

      for (const finding of input.findings) {
        await client.query(
          `INSERT INTO findings (
             review_run_id, diff_hunk_id, severity, category, title, body, file_path, line, line_end,
             confidence, suggested_fix, should_post, ai_finding_key, gitlab_position
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
           ON CONFLICT (review_run_id, ai_finding_key) WHERE ai_finding_key IS NOT NULL DO UPDATE
           SET diff_hunk_id = EXCLUDED.diff_hunk_id,
               severity = EXCLUDED.severity,
               category = EXCLUDED.category,
               title = EXCLUDED.title,
               body = EXCLUDED.body,
               file_path = EXCLUDED.file_path,
               line = EXCLUDED.line,
               line_end = EXCLUDED.line_end,
               confidence = EXCLUDED.confidence,
               suggested_fix = EXCLUDED.suggested_fix,
               should_post = EXCLUDED.should_post,
               gitlab_position = EXCLUDED.gitlab_position`,
          [
            input.reviewRunId,
            finding.diffHunkId,
            finding.severity,
            finding.category,
            finding.title,
            finding.rationale,
            finding.filePath,
            finding.line,
            finding.lineEnd,
            finding.confidence,
            finding.suggestedFix,
            finding.shouldPost,
            finding.aiFindingKey,
            finding.gitlabPosition === null ? null : JSON.stringify(finding.gitlabPosition)
          ]
        );
      }

      const result = await client.query(
        `UPDATE review_runs
         SET status = 'completed',
             summary = $2,
             error_message = NULL,
             ai_model = $3,
             overview_comment_body = $4,
             completed_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [input.reviewRunId, input.summary, input.model, input.overviewCommentBody]
      );
      if ((result.rowCount ?? 0) === 0) throw new Error('Review run not found');
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async failAiReview(reviewRunId: string, error: Error): Promise<void> {
    const message = sanitizePersistedError(error.message);
    const result = await this.#pool.query(
      `UPDATE review_runs
       SET status = 'failed',
           error_message = $2,
           completed_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [reviewRunId, message]
    );
    if ((result.rowCount ?? 0) === 0) throw new Error('Review run not found');
  }

  async getAiOverviewPost(reviewRunId: string): Promise<AiOverviewPostRecord | null> {
    const result = await this.#pool.query<{ gitlab_discussion_id: string; gitlab_note_id: string | null }>(
      `SELECT d.gitlab_discussion_id, c.gitlab_note_id
       FROM discussions d
       LEFT JOIN comments c ON c.discussion_id = d.id AND c.author_type = 'hunkwise'
       WHERE d.review_run_id = $1
         AND d.idempotency_key = 'ai-overview'
         AND d.gitlab_discussion_id IS NOT NULL
       ORDER BY c.created_at NULLS LAST, c.id
       LIMIT 1`,
      [reviewRunId]
    );
    const row = result.rows[0];
    return row ? { gitlabDiscussionId: row.gitlab_discussion_id, gitlabNoteId: row.gitlab_note_id } : null;
  }

  async recordAiFindingPosted(input: PostAiFindingInput): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE findings
         SET gitlab_discussion_id = $3,
             gitlab_note_id = $4,
             posted_at = COALESCE(posted_at, now()),
             post_error = NULL
         WHERE review_run_id = $1 AND id = $2`,
        [input.reviewRunId, input.findingId, input.gitlabDiscussionId, input.gitlabNoteId]
      );
      const discussion = await client.query<{ id: string }>(
        `INSERT INTO discussions (review_run_id, finding_id, gitlab_discussion_id, resolved, idempotency_key)
         VALUES ($1, $2, $3, false, $4)
         ON CONFLICT (review_run_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
         SET gitlab_discussion_id = EXCLUDED.gitlab_discussion_id
         RETURNING id`,
        [input.reviewRunId, input.findingId, input.gitlabDiscussionId, `ai-finding:${input.findingId}`]
      );
      const discussionId = discussion.rows[0]?.id;
      if (!discussionId) throw new Error('AI discussion insert returned no row');
      await client.query(
        `INSERT INTO comments (discussion_id, author_type, author_name, body, gitlab_note_id)
         SELECT $1, 'hunkwise', 'Hunkwise', body, $3
         FROM findings WHERE review_run_id = $2 AND id = $4
         ON CONFLICT (discussion_id, gitlab_note_id) WHERE gitlab_note_id IS NOT NULL DO NOTHING`,
        [discussionId, input.reviewRunId, input.gitlabNoteId, input.findingId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAiOverviewPosted(input: RecordAiOverviewPostInput): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const discussion = await client.query<{ id: string }>(
        `INSERT INTO discussions (review_run_id, gitlab_discussion_id, resolved, idempotency_key)
         VALUES ($1, $2, false, 'ai-overview')
         ON CONFLICT (review_run_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
         SET gitlab_discussion_id = EXCLUDED.gitlab_discussion_id
         RETURNING id`,
        [input.reviewRunId, input.gitlabDiscussionId]
      );
      const discussionId = discussion.rows[0]?.id;
      if (!discussionId) throw new Error('AI overview discussion insert returned no row');
      await client.query(
        `INSERT INTO comments (discussion_id, author_type, author_name, body, gitlab_note_id)
         VALUES ($1, 'hunkwise', 'Hunkwise', $2, $3)
         ON CONFLICT (discussion_id, gitlab_note_id) WHERE gitlab_note_id IS NOT NULL DO NOTHING`,
        [discussionId, input.body, input.gitlabNoteId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordGitLabWebhook(input: RecordGitLabWebhookInput): Promise<RecordGitLabWebhookResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO gitlab_webhook_events (instance_id, event_key, event_type, payload, processing_started_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (instance_id, event_key) DO NOTHING
         RETURNING id`,
        [input.instanceId, input.eventKey, input.eventType, JSON.stringify(input.payload)]
      );
      const insertedId = inserted.rows[0]?.id;
      if (insertedId) {
        await client.query('COMMIT');
        return { eventId: insertedId, duplicate: false, state: 'claimed', reviewRunId: null };
      }

      const existing = await client.query<{
        id: string;
        review_run_id: string | null;
        processed_at: Date | null;
        processing_started_at: Date | null;
        failed_at: Date | null;
      }>(
        `SELECT id, review_run_id, processed_at, processing_started_at, failed_at
         FROM gitlab_webhook_events
         WHERE instance_id = $1 AND event_key = $2
         FOR UPDATE`,
        [input.instanceId, input.eventKey]
      );
      const row = existing.rows[0];
      if (!row) throw new Error('Webhook event conflict row not found');
      if (row.processed_at) {
        await client.query('COMMIT');
        return { eventId: row.id, duplicate: true, state: 'completed_duplicate', reviewRunId: row.review_run_id };
      }
      const activeClaim = row.processing_started_at && !row.failed_at && Date.now() - row.processing_started_at.getTime() < 10 * 60 * 1000;
      if (activeClaim) {
        await client.query('COMMIT');
        return { eventId: row.id, duplicate: true, state: 'in_progress', reviewRunId: null };
      }
      await client.query(
        `UPDATE gitlab_webhook_events
         SET event_type = $2,
             payload = $3::jsonb,
             processing_started_at = now(),
             failed_at = NULL,
             failure_message = NULL
         WHERE id = $1`,
        [row.id, input.eventType, JSON.stringify(input.payload)]
      );
      await client.query('COMMIT');
      return { eventId: row.id, duplicate: false, state: 'claimed', reviewRunId: null };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeGitLabWebhook(eventId: string, reviewRunId: string | null): Promise<void> {
    await this.#pool.query(
      'UPDATE gitlab_webhook_events SET review_run_id = $2, processed_at = now(), failed_at = NULL, failure_message = NULL WHERE id = $1 AND processed_at IS NULL',
      [eventId, reviewRunId]
    );
  }

  async failGitLabWebhook(eventId: string, error: Error): Promise<void> {
    await this.#pool.query(
      `UPDATE gitlab_webhook_events
       SET failed_at = now(), failure_message = left($2, 2000)
       WHERE id = $1 AND processed_at IS NULL`,
      [eventId, error.message]
    );
  }
}
