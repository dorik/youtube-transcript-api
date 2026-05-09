import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { pool } from './pool';
import { logger } from '../config/logger';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Tiny SQL migration runner.
 *
 * - Tracks applied migrations in `_migrations`.
 * - Runs every `*.sql` file in alphabetical order.
 * - Each file is executed as a single multi-statement query, so each file
 *   should be idempotent (uses `IF NOT EXISTS`).
 */
async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getApplied(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM _migrations',
  );
  return new Set(rows.map((r) => r.filename));
}

async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getApplied();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    logger.info('No migration files found.');
    return;
  }

  let ranCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      logger.debug({ file }, 'Skipping already-applied migration');
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    logger.info({ file }, 'Applying migration');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ranCount++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err, file }, 'Migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info({ ranCount, total: files.length }, 'Migrations complete');
}

runMigrations()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'Migration runner failed');
    process.exit(1);
  });
