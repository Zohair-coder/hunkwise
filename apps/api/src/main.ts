import process from 'node:process';
import { PostgresStore, postgresSsl } from '@hunkwise/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { AesGcmSecretCipher } from './crypto.js';
import { UnavailableGitLabGateway, UnavailableReviewEngine } from './services.js';

const config = loadConfig();
const store = new PostgresStore({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: postgresSsl(config.DATABASE_SSL_MODE)
});
const app = await buildApp(
  {
    store,
    cipher: new AesGcmSecretCipher(config.APP_ENCRYPTION_KEY),
    gitlab: new UnavailableGitLabGateway(),
    reviewEngine: new UnavailableReviewEngine()
  },
  {
    logger: { level: config.LOG_LEVEL },
    serveFrontend: config.NODE_ENV === 'production',
    ...(config.WEB_DIST_DIR ? { webDistDir: config.WEB_DIST_DIR } : {})
  }
);

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await app.close();
    await store.close();
    clearTimeout(force);
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal({ err: error }, 'startup failed');
  await store.close();
  process.exit(1);
}
