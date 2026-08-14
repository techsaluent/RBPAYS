import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from '../src/config/env';
import { logger } from '../src/config/logger';

const ssl =
  env.PGSSLMODE === 'require' || env.PGSSLMODE === 'prefer'
    ? { rejectUnauthorized: false }
    : undefined;

export const pool = new Pool(
  env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL, max: env.PG_POOL_MAX, ssl }
    : {
        host: env.PGHOST,
        port: env.PGPORT,
        user: env.PGUSER,
        password: env.PGPASSWORD,
        database: env.PGDATABASE,
        max: env.PG_POOL_MAX,
        ssl,
      },
);

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected idle postgres client error');
});

/** Run a parameterised query using a pooled client. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Run `fn` inside a single BEGIN/COMMIT transaction. Rolls back on any throw.
 * Use for every money movement so the wallet ledger stays consistent.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
