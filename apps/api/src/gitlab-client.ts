import type { GitLabPosition } from '@hunkwise/contracts';
import type { GitLabAccessToken } from './credentials.js';

export class GitLabClientError extends Error {
  constructor(
    readonly statusCode: number | null,
    readonly code: 'timeout' | 'network_error' | 'rate_limited' | 'unauthorized' | 'forbidden' | 'not_found' | 'bad_request' | 'server_error' | 'unexpected_response',
    message: string
  ) {
    super(message);
    this.name = 'GitLabClientError';
  }
}

export interface GitLabClientOptions {
  baseUrl: string;
  token: GitLabAccessToken;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  backoffMs?: number;
}

export interface GitLabUser { username?: string; name?: string }
export interface GitLabVersion { version?: string }
export interface GitLabAuthor { username?: string; name?: string }
export interface GitLabDiffRefs { base_sha?: string; start_sha?: string; head_sha?: string }
export interface GitLabMergeRequest {
  project_id: number;
  iid: number;
  title: string;
  source_branch: string;
  target_branch: string;
  sha?: string;
  diff_refs?: GitLabDiffRefs;
  web_url: string;
  state: 'opened' | 'open' | 'merged' | 'closed';
  author?: GitLabAuthor;
  detailed_merge_status?: string;
}
export interface GitLabProject {
  id: number;
  path_with_namespace: string;
  default_branch?: string | null;
  web_url: string;
}
export interface GitLabDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  collapsed?: boolean;
  too_large?: boolean;
  generated_file?: boolean;
}
export interface GitLabNote {
  id: number | string;
  body: string;
  author?: GitLabAuthor;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  created_at?: string;
}
export interface GitLabDiscussion {
  id: string;
  individual_note?: boolean;
  notes?: GitLabNote[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const statusCode = (status: number): GitLabClientError['code'] => {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unexpected_response';
};

const encodeProject = (project: number | string): string =>
  typeof project === 'number' ? String(project) : encodeURIComponent(project);

const nextFromLink = (link: string | null): boolean => {
  if (!link) return false;
  return link.split(',').some((part) => /;\s*rel="?next"?/.test(part));
};

export class GitLabClient {
  readonly #baseUrl: string;
  readonly #token: GitLabAccessToken;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #fetch: typeof fetch;
  readonly #backoffMs: number;

  constructor(options: GitLabClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#retries = options.retries ?? 2;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#backoffMs = options.backoffMs ?? 100;
  }

  async testConnection(): Promise<{ username: string | null; version: string | null }> {
    const user = await this.request<GitLabUser>('GET', '/user').catch((error: unknown) => {
      if (error instanceof GitLabClientError && error.statusCode === 404) return null;
      throw error;
    });
    const version = await this.request<GitLabVersion>('GET', '/version').catch(() => null);
    return { username: user?.username ?? user?.name ?? null, version: version?.version ?? null };
  }

  getMergeRequest(projectPath: string | number, iid: number): Promise<GitLabMergeRequest> {
    return this.request('GET', `/projects/${encodeProject(projectPath)}/merge_requests/${iid}`);
  }

  getProject(projectId: number): Promise<GitLabProject> {
    return this.request('GET', `/projects/${projectId}`);
  }

  listMergeRequestDiffs(projectId: number, iid: number): Promise<GitLabDiff[]> {
    return this.paginated(`/projects/${projectId}/merge_requests/${iid}/diffs`, 100);
  }

  listMergeRequestDiscussions(projectId: number, iid: number): Promise<GitLabDiscussion[]> {
    return this.paginated(`/projects/${projectId}/merge_requests/${iid}/discussions`, 100);
  }

  createOverviewDiscussion(projectId: number, iid: number, body: string): Promise<GitLabDiscussion> {
    return this.request('POST', `/projects/${projectId}/merge_requests/${iid}/discussions`, { body });
  }

  createDiffDiscussion(projectId: number, iid: number, body: string, position: GitLabPosition): Promise<GitLabDiscussion> {
    return this.request('POST', `/projects/${projectId}/merge_requests/${iid}/discussions`, {
      body,
      position: {
        base_sha: position.baseSha,
        start_sha: position.startSha,
        head_sha: position.headSha,
        position_type: position.positionType,
        old_path: position.oldPath,
        new_path: position.newPath,
        ...(position.oldLine === undefined ? {} : { old_line: position.oldLine }),
        ...(position.newLine === undefined ? {} : { new_line: position.newLine })
      }
    });
  }

  replyToDiscussion(projectId: number, iid: number, discussionId: string, body: string): Promise<GitLabNote> {
    return this.request('POST', `/projects/${projectId}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`, { body });
  }

  setDiscussionResolved(projectId: number, iid: number, discussionId: string, resolved: boolean): Promise<GitLabDiscussion> {
    return this.request('PUT', `/projects/${projectId}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`, { resolved });
  }

  async paginated<T>(path: string, perPage: number): Promise<T[]> {
    const items: T[] = [];
    let page: string | null = '1';
    while (page) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await this.raw('GET', `${path}${separator}page=${page}&per_page=${perPage}`);
      const json = await response.json().catch(() => {
        throw new GitLabClientError(response.status, 'unexpected_response', `GitLab returned invalid JSON for ${path}`);
      }) as unknown;
      if (!Array.isArray(json)) throw new GitLabClientError(response.status, 'unexpected_response', `GitLab returned a non-list response for ${path}`);
      items.push(...json as T[]);
      const headerNext = response.headers.get('x-next-page');
      page = headerNext && headerNext.trim() !== '' ? headerNext : (nextFromLink(response.headers.get('link')) ? String(Number(page) + 1) : null);
    }
    return items;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.raw(method, path, body);
    return response.json().catch(() => {
      throw new GitLabClientError(response.status, 'unexpected_response', `GitLab returned invalid JSON for ${path}`);
    }) as Promise<T>;
  }

  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const init: RequestInit = {
          method,
          headers: {
            'PRIVATE-TOKEN': this.#token,
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          },
          signal: controller.signal
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        const response = await this.#fetch(this.url(path), init);
        if (response.ok) return response;
        if ((response.status === 429 || response.status >= 500) && attempt < this.#retries) {
          await sleep(this.retryDelay(response, attempt));
          attempt += 1;
          continue;
        }
        throw new GitLabClientError(response.status, statusCode(response.status), `GitLab request failed with HTTP ${response.status} for ${path}`);
      } catch (error) {
        if (error instanceof GitLabClientError) throw error;
        if (error instanceof Error && error.name === 'AbortError') {
          if (attempt < this.#retries) {
            await sleep(this.#backoffMs * (attempt + 1));
            attempt += 1;
            continue;
          }
          throw new GitLabClientError(null, 'timeout', `GitLab request timed out for ${path}`);
        }
        if (attempt < this.#retries) {
          await sleep(this.#backoffMs * (attempt + 1));
          attempt += 1;
          continue;
        }
        throw new GitLabClientError(null, 'network_error', `GitLab request failed for ${path}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private url(path: string): URL {
    const parsed = new URL(this.#baseUrl);
    const prefix = parsed.pathname.replace(/\/+$/, '');
    const apiPath = `${prefix}/api/v4${path.startsWith('/') ? path : `/${path}`}`;
    return new URL(apiPath, parsed.origin);
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(Number(retryAfter) * 1000, 5_000);
    return this.#backoffMs * 2 ** attempt;
  }
}
