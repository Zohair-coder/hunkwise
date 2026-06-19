import type { PoolConfig } from 'pg';

export const databaseSslModes = ['disable', 'require', 'verify-full'] as const;
export type DatabaseSslMode = typeof databaseSslModes[number];

export function parseDatabaseSslMode(value: string): DatabaseSslMode {
  if (databaseSslModes.includes(value as DatabaseSslMode)) return value as DatabaseSslMode;
  throw new Error(`DATABASE_SSL_MODE must be one of: ${databaseSslModes.join(', ')}`);
}

export function postgresSsl(mode: DatabaseSslMode): PoolConfig['ssl'] {
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}
