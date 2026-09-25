import type postgres from 'postgres';
import { loadEnv, type Env } from './config/env.js';
import type { Logger } from 'pino';
import { createLogger } from './logging/logger.js';
import { buildApp } from './app.js';
import { createPostgresClient, PostgresDb } from './db/postgres/index.js';

/**
 * The dev database, when `POSTGRES_APP_URL` is set and this is the dev
 * environment. Anywhere else the URL is ignored (with a warning): real
 * environments read DB credentials from Secrets Manager (ADR-0007 §2),
 * which is not wired yet, so they start without the data routes.
 */
function devDatabase(env: Env, logger: Logger): { sql: postgres.Sql; repos: PostgresDb } | null {
  if (!env.POSTGRES_APP_URL) return null;
  if (env.CLOUDPUNCH_ENV !== 'dev') {
    logger.warn({ env: env.CLOUDPUNCH_ENV }, 'POSTGRES_APP_URL ignored outside CLOUDPUNCH_ENV=dev');
    return null;
  }
  const sql = createPostgresClient(env.POSTGRES_APP_URL);
  logger.info('using dev Postgres from POSTGRES_APP_URL');
  return { sql, repos: new PostgresDb(sql) };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
    serviceName: env.OTEL_SERVICE_NAME,
    appVersion: env.APP_VERSION,
    env: env.CLOUDPUNCH_ENV,
  });

  const db = devDatabase(env, logger);
  const app = await buildApp({ env, logger, db: db?.repos });
  if (db) app.addHook('onClose', async () => db.sql.end());

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown initiated');
    try {
      await app.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    logger.info({ port: env.PORT, host: env.HOST }, 'listening');
  } catch (err) {
    logger.fatal({ err }, 'failed to start');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'unhandled bootstrap error', err: String(err) })}\n`,
  );
  process.exit(1);
});
