import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GitLabInstance, Pagination, ReviewDetail, ReviewList } from '@hunkwise/contracts';
import type { HunkwiseStore, NewInstanceRecord, UpdateInstanceRecord } from '@hunkwise/db';
import { buildApp } from '../src/app.js';
import { AesGcmSecretCipher } from '../src/crypto.js';
import { UnavailableGitLabGateway, UnavailableReviewEngine } from '../src/services.js';

class MemoryStore implements HunkwiseStore {
  instances = new Map<string, GitLabInstance>();
  encryptedTokens: string[] = [];
  failPing = false;
  review: ReviewDetail | null = null;
  async ping(): Promise<void> { if (this.failPing) throw new Error('down'); }
  async close(): Promise<void> {}
  async listInstances(): Promise<GitLabInstance[]> { return [...this.instances.values()]; }
  async getInstance(id: string): Promise<GitLabInstance | null> { return this.instances.get(id) ?? null; }
  async createInstance(input: NewInstanceRecord): Promise<GitLabInstance> {
    const now = new Date().toISOString();
    const value = { id: randomUUID(), name: input.name, baseUrl: input.baseUrl, hasAccessToken: true, createdAt: now, updatedAt: now };
    this.encryptedTokens.push(input.encryptedAccessToken);
    this.instances.set(value.id, value);
    return value;
  }
  async updateInstance(id: string, input: UpdateInstanceRecord): Promise<GitLabInstance | null> {
    const current = this.instances.get(id);
    if (!current) return null;
    const value = { ...current, ...(input.name ? { name: input.name } : {}), ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), updatedAt: new Date().toISOString() };
    if (input.encryptedAccessToken) this.encryptedTokens.push(input.encryptedAccessToken);
    this.instances.set(id, value);
    return value;
  }
  async deleteInstance(id: string): Promise<boolean> { return this.instances.delete(id); }
  async listReviews(page: Pagination): Promise<ReviewList> { return { items: [], total: 0, ...page }; }
  async getReview(id: string): Promise<ReviewDetail | null> { return this.review?.run.id === id ? this.review : null; }
}

const setup = async () => {
  const store = new MemoryStore();
  const app = await buildApp({
    store,
    cipher: new AesGcmSecretCipher(randomBytes(32).toString('base64')),
    gitlab: new UnavailableGitLabGateway(),
    reviewEngine: new UnavailableReviewEngine()
  });
  return { app, store };
};

describe('API', () => {
  it('reports liveness and database readiness', async () => {
    const { app, store } = await setup();
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    store.failPing = true;
    const unavailable = await app.inject({ method: 'GET', url: '/health/ready', headers: { 'x-request-id': 'ready-outage' } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: { code: 'dependency_unavailable', requestId: 'ready-outage', details: { checks: { database: 'unavailable' } } } });
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    store.failPing = false;
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    await app.close();
  });

  it('creates, lists, updates and deletes instances without exposing tokens', async () => {
    const { app, store } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Team', baseUrl: 'https://gitlab.example.com/', accessToken: 'glpat-secret' } });
    expect(created.statusCode).toBe(201);
    const body = created.json<GitLabInstance>();
    expect(body).not.toHaveProperty('accessToken');
    expect(store.encryptedTokens[0]).not.toContain('glpat-secret');
    expect((await app.inject({ method: 'GET', url: '/api/instances' })).json().items).toHaveLength(1);
    expect((await app.inject({ method: 'PATCH', url: `/api/instances/${body.id}`, payload: { name: 'Platform' } })).json().name).toBe('Platform');
    expect((await app.inject({ method: 'DELETE', url: `/api/instances/${body.id}` })).statusCode).toBe(204);
    await app.close();
  });

  it('validates requests and returns request IDs', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/instances', headers: { 'x-request-id': 'test-request' }, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.headers['x-request-id']).toBe('test-request');
    expect(response.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('rejects GitLab URLs containing userinfo', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Unsafe', baseUrl: 'https://user:password@gitlab.example.com', accessToken: 'secret' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('preserves parser, body limit, and UUID error semantics in the standard envelope', async () => {
    const { app } = await setup();
    const malformed = await app.inject({ method: 'POST', url: '/api/instances', headers: { 'content-type': 'application/json', 'x-request-id': 'bad-json' }, payload: '{"name":' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'invalid_json', requestId: 'bad-json' } });

    const oversized = await app.inject({ method: 'POST', url: '/api/instances', headers: { 'content-type': 'application/json', 'x-request-id': 'too-big' }, payload: `"${'x'.repeat(1024 * 1024 + 1)}"` });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ error: { code: 'payload_too_large', requestId: 'too-big' } });

    const invalidId = await app.inject({ method: 'GET', url: '/api/instances/not-a-uuid', headers: { 'x-request-id': 'bad-id' } });
    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.json()).toMatchObject({ error: { code: 'invalid_request', requestId: 'bad-id' } });
    await app.close();
  });

  it('fails review submission clearly while GitLab is unavailable', async () => {
    const { app } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Team', baseUrl: 'https://gitlab.example.com', accessToken: 'secret' } });
    const response = await app.inject({ method: 'POST', url: '/api/reviews', payload: { instanceId: created.json().id, mergeRequestUrl: 'https://gitlab.example.com/group/project/-/merge_requests/7' } });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe('integration_not_implemented');
    await app.close();
  });

  it('serves persisted review detail through the detail contract', async () => {
    const { app, store } = await setup();
    const now = new Date().toISOString();
    const id = randomUUID();
    store.review = {
      run: { id, mergeRequestId: randomUUID(), status: 'completed', sourceSha: 'abc123', summary: null, errorMessage: null, startedAt: now, completedAt: now, createdAt: now, updatedAt: now },
      files: [], hunks: [], findings: [], discussions: [], comments: [], chatMessages: []
    };
    const response = await app.inject({ method: 'GET', url: `/api/reviews/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ run: { id }, files: [], findings: [], chatMessages: [] });
    await app.close();
  });
});
