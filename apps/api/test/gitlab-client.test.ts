import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitLabAccessToken } from '../src/credentials.js';
import { GitLabClient, GitLabClientError } from '../src/gitlab-client.js';

let server: http.Server;
let baseUrl: string;
let handler: (request: IncomingMessage, response: ServerResponse) => void;
const requests: IncomingMessage[] = [];

const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};

beforeEach(async () => {
  requests.length = 0;
  handler = (_request, response) => json(response, 404, { message: 'not found' });
  server = http.createServer((request, response) => {
    requests.push(request);
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  baseUrl = `http://127.0.0.1:${address.port}/gitlab`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const client = () => new GitLabClient({ baseUrl, token: 'glpat-secret' as GitLabAccessToken, backoffMs: 1, retries: 1 });

describe('GitLab REST client', () => {
  it('uses PRIVATE-TOKEN auth and paginates through x-next-page', async () => {
    handler = (request, response) => {
      expect(request.headers['private-token']).toBe('glpat-secret');
      if (request.url === '/gitlab/api/v4/projects/1/merge_requests/2/diffs?page=1&per_page=100') {
        json(response, 200, [{ new_path: 'one.ts' }], { 'x-next-page': '2' });
        return;
      }
      if (request.url === '/gitlab/api/v4/projects/1/merge_requests/2/diffs?page=2&per_page=100') {
        json(response, 200, [{ new_path: 'two.ts' }]);
        return;
      }
      json(response, 404, {});
    };
    const diffs = await client().listMergeRequestDiffs(1, 2);
    expect(diffs.map((diff) => diff.new_path)).toEqual(['one.ts', 'two.ts']);
    expect(requests).toHaveLength(2);
  });

  it('retries 429/5xx responses and maps final errors without logging tokens', async () => {
    let attempts = 0;
    handler = (_request, response) => {
      attempts += 1;
      json(response, attempts === 1 ? 500 : 429, { message: 'slow down' });
    };
    await expect(client().getProject(1)).rejects.toMatchObject({ code: 'rate_limited', statusCode: 429 });
    await expect(client().getProject(1)).rejects.not.toThrow(/glpat-secret/);
    expect(attempts).toBe(4);
  });

  it('maps unauthorized responses and supports /user connection tests', async () => {
    handler = (request, response) => {
      if (request.url === '/gitlab/api/v4/user') {
        json(response, 200, { username: 'root' });
        return;
      }
      if (request.url === '/gitlab/api/v4/version') {
        json(response, 200, { version: '17.0.0' });
        return;
      }
      json(response, 401, { message: 'bad token' });
    };
    await expect(client().testConnection()).resolves.toEqual({ username: 'root', version: '17.0.0' });
    await expect(client().getProject(123)).rejects.toBeInstanceOf(GitLabClientError);
    await expect(client().getProject(123)).rejects.toMatchObject({ code: 'unauthorized', statusCode: 401 });
  });
});
