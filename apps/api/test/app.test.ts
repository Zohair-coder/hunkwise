import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GitLabInstance, Pagination, ReviewList, ReviewRun } from '@hunkwise/contracts';
import type { HunkwiseStore, NewInstanceRecord, UpdateInstanceRecord } from '@hunkwise/db';
import { buildApp } from '../src/app.js';
import { AesGcmSecretCipher } from '../src/crypto.js';
import { UnavailableGitLabGateway, UnavailableReviewEngine } from '../src/services.js';

class MemoryStore implements HunkwiseStore {
  instances = new Map<string, GitLabInstance>();
  encryptedTokens: string[] = [];
  failPing = false;
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
  async getReview(_id: string): Promise<ReviewRun | null> { return null; }
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
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
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

  it('fails review submission clearly while GitLab is unavailable', async () => {
    const { app } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Team', baseUrl: 'https://gitlab.example.com', accessToken: 'secret' } });
    const response = await app.inject({ method: 'POST', url: '/api/reviews', payload: { instanceId: created.json().id, mergeRequestUrl: 'https://gitlab.example.com/group/project/-/merge_requests/7' } });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe('integration_not_implemented');
    await app.close();
  });
});

