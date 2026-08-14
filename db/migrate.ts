/**
 * Minimal forward-only migration runner.
 * Applies every *.sql file in db/migrations in filename order exactly once,
 * tracking applied files in the schema_migrations table.
 *
 *   npm run migrate          # apply pending migrations
 *   npm run migrate:status   # show applied / pending
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pool } from './index';
import { logger } from '../src/config/logger';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function appliedSet(): Promise<Set<string>> {
  const { rows } = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations',
  );
  return new Set(rows.map((r) => r.name));
}

async function up(): Promise<void> {
  await ensureTable();
  const applied = await appliedSet();
  const pending = migrationFiles().filter((f) => !applied.has(f));

  if (pending.length === 0) {
    logger.info('no pending migrations');
    return;
  }

  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    logger.info({ file }, 'applying migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
        file,
      ]);
      await client.query('COMMIT');
      logger.info({ file }, 'applied');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ file, err }, 'migration failed, rolled back');
      throw err;
    } finally {
      client.release();
    }
  }
}

async function status(): Promise<void> {
  await ensureTable();
  const applied = await appliedSet();
  for (const file of migrationFiles()) {
    // eslint-disable-next-line no-console
    console.log(`${applied.has(file) ? '[x]' : '[ ]'} ${file}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  if (cmd === 'up') await up();
  else if (cmd === 'status') await status();
  else throw new Error(`unknown command: ${cmd}`);
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, 'migration runner error');
  process.exit(1);
});
