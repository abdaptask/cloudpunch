import { loadEnv } from './config/env.js';
import { createLogger } from './logging/logger.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
    serviceName: env.OTEL_SERVICE_NAME,
    appVersion: env.APP_VERSION,
    env: env.CLOUDPUNCH_ENV,
  });

  const app = await buildApp({ env, logger });

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
