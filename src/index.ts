import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { closePool, pool } from '../db';
import { refreshProviderRegistry } from './providers/registry';
import { refreshTaxConfig } from './modules/tax/tax.config';

async function main() {
  // Fail fast if the VPS database is unreachable at boot.
  await pool.query('SELECT 1');
  logger.info('database connection ok');

  // Load the super-admin's active provider selection + tax rates into memory.
  await refreshProviderRegistry();
  await refreshTaxConfig();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`RBPAYS API listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    // Force exit if graceful shutdown stalls.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
