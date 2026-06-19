import { z } from 'zod';
import { databaseSslModes, type DatabaseSslMode } from '@hunkwise/db';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL_MODE: z.enum(databaseSslModes).optional(),
  APP_ENCRYPTION_KEY: z.string().refine((value) => {
    try {
      return Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value;
    } catch { return false; }
  }, 'Must be a base64-encoded 32-byte key'),
  WEB_DIST_DIR: z.string().optional()
});

export type AppConfig = Omit<z.infer<typeof configSchema>, 'DATABASE_SSL_MODE'> & { DATABASE_SSL_MODE: DatabaseSslMode };

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(environment);
  const { DATABASE_SSL_MODE, ...rest } = parsed;
  return { ...rest, DATABASE_SSL_MODE: DATABASE_SSL_MODE ?? (parsed.NODE_ENV === 'production' ? 'verify-full' : 'disable') };
}
