import { Pool, type PoolConfig } from 'pg';
import type {
  GitLabInstance,
  Pagination,
  ReviewList,
  ReviewRun
} from '@hunkwise/contracts';

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
  getReview(id: string): Promise<ReviewRun | null>;
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

export class PostgresStore implements HunkwiseStore {
  readonly #pool: Pool;

  constructor(config: PoolConfig | Pool) {
    this.#pool = config instanceof Pool ? config : new Pool(config);
  }

  async ping(): Promise<void> {
    await this.#pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.#pool.end();
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
    const [rows, count] = await Promise.all([
      this.#pool.query<ReviewRow>(
        `SELECT id, merge_request_id, status, source_sha, summary, error_message,
                started_at, completed_at, created_at, updated_at
         FROM review_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [page.limit, page.offset]
      ),
      this.#pool.query<{ count: string }>('SELECT count(*)::text AS count FROM review_runs')
    ]);
    return {
      items: rows.rows.map(mapReview),
      total: Number(count.rows[0]?.count ?? 0),
      limit: page.limit,
      offset: page.offset
    };
  }

  async getReview(id: string): Promise<ReviewRun | null> {
    const result = await this.#pool.query<ReviewRow>(
      `SELECT id, merge_request_id, status, source_sha, summary, error_message,
              started_at, completed_at, created_at, updated_at
       FROM review_runs WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapReview(result.rows[0]) : null;
  }
}

