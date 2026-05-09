import { Pool, PoolClient } from 'pg';
import { config } from '../config/env';
import { logger } from '../config/logger';

// Neon (and most managed Postgres) use sslmode=require in the URL. The pg
// driver doesn't auto-translate that into a TLS connection unless we also
// set `ssl`. For self-hosted local Postgres without TLS we leave it off.
const requiresSsl = /sslmode=require/i.test(config.DATABASE_URL);

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle pg client error');
});

/**
 * Run a callback inside a transaction. The client is released regardless of
 * outcome and rolled back on any thrown error.
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
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
