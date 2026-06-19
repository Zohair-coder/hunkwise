import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://localhost/hunkwise', APP_ENCRYPTION_KEY: randomBytes(32).toString('base64') };

describe('database TLS configuration', () => {
  it('defaults production to certificate verification', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).DATABASE_SSL_MODE).toBe('verify-full');
  });

  it('allows an explicit mode and rejects unknown values', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production', DATABASE_SSL_MODE: 'disable' }).DATABASE_SSL_MODE).toBe('disable');
    expect(() => loadConfig({ ...base, DATABASE_SSL_MODE: 'prefer' })).toThrow();
  });
});

