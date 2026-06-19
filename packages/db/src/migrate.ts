import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { parseDatabaseSslMode, postgresSsl, type DatabaseSslMode } from './ssl.js';

const checksum = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function migrate(databaseUrl: string, migrationsDirectory?: string, sslMode: DatabaseSslMode = 'disable'): Promise<void> {
  const directory = migrationsDirectory ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(sslMode) });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(487501921)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
    const applied = await client.query<{ name: string; checksum: string | null }>('SELECT name, checksum FROM schema_migrations');
    const known = new Map(applied.rows.map((row) => [row.name, row.checksum]));
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(directory, file), 'utf8');
      const fileChecksum = checksum(sql);
      const appliedChecksum = known.get(file);
      if (appliedChecksum !== undefined) {
        if (appliedChecksum === null) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [file, fileChecksum]);
        } else if (appliedChecksum !== fileChecksum) {
          throw new Error(`Migration checksum mismatch for ${file}`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, fileChecksum]);
        await client.query('COMMIT');
        console.info(`Applied migration ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(487501921)').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const sslMode = parseDatabaseSslMode(process.env.DATABASE_SSL_MODE ?? (process.env.NODE_ENV === 'production' ? 'verify-full' : 'disable'));
  await migrate(databaseUrl, process.env.MIGRATIONS_DIR, sslMode);
}
