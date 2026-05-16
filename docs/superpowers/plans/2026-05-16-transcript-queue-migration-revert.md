# Transcript Queue — Migration 013 Revert Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a one-command rollback for migration `013_transcript_queue.sql` — drop the async-queue tables, restore the pre-013 schema, and let the migration be re-applied later.

**Architecture:** The migration runner (`backend/src/db/migrate.ts`) is forward-only — it has no down-migrations. This plan adds a standalone SQL revert script plus a small Node runner and an npm script, mirroring the `db:migrate` pattern. The revert is a manual, deliberate operation; it is never placed in `migrations/` (the runner would otherwise try to apply it as a new migration).

**Tech Stack:** PostgreSQL, `pg`, ts-node-dev.

**Depends on:** the backend plan `docs/superpowers/plans/2026-05-16-async-transcript-queue-backend.md` — specifically migration `013_transcript_queue.sql` must exist. This revert undoes exactly that migration.

---

## What migration 013 did (the thing being reverted)

`013_transcript_queue.sql`:
- **created** `transcript_requests` and `transcript_batches`;
- **dropped** `jobs` and `job_videos` (the unused tables from migration `010_jobs.sql`).

So the revert must do the inverse: drop the two new tables, recreate the two old ones exactly as `010` defined them, and remove the `013` row from `_migrations`.

## When to run this revert

- Migration `013` was applied to the wrong database (e.g. production instead of a dev database) and must be undone.
- The `feat/queue` branch is being permanently abandoned and a shared database must be returned to `main`'s schema.

**Not** as a routine "switch back to `main`" step. Reverting on every `git checkout main` and re-migrating on every return is fragile and destroys all queue rows each round trip. To develop this branch without touching `main`/production, isolate the database instead — point `feat/queue`'s `backend/.env` `DATABASE_URL` at a separate database (a Neon database branch, or the local Docker Postgres via `docker compose up -d`).

## Destructiveness

The revert **drops `transcript_requests` and `transcript_batches`** — every queued, processing, and completed row is permanently deleted. There is no recovery for in-flight queue work after a revert. The recreated `jobs` / `job_videos` tables come back empty (they were never written to).

---

## File Structure

**Create:**
- `backend/scripts/revert_013_transcript_queue.sql` — the rollback SQL (one transaction).
- `backend/scripts/revert-013.ts` — Node runner that executes the SQL file against `DATABASE_URL`.

**Modify:**
- `backend/package.json` — add a `db:revert:013` script.

---

## Task 1: Write the revert SQL

**Files:**
- Create: `backend/scripts/revert_013_transcript_queue.sql`

- [ ] **Step 1: Write the SQL**

Create `backend/scripts/revert_013_transcript_queue.sql`:

```sql
-- ROLLBACK for migration 013_transcript_queue.sql.
--
-- Drops the async-queue tables, recreates the pre-013 jobs / job_videos
-- tables exactly as 010_jobs.sql defined them, and removes the 013 row from
-- _migrations so `npm run db:migrate` can re-apply it later.
--
-- DESTRUCTIVE: every transcript_requests / transcript_batches row is lost.
-- Run via:  npm run db:revert:013   (from backend/)

BEGIN;

-- transcript_requests has an FK to transcript_batches, so it drops first.
DROP TABLE IF EXISTS transcript_requests;
DROP TABLE IF EXISTS transcript_batches;

-- Recreate the pre-013 tables verbatim from migration 010_jobs.sql.
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_type VARCHAR(20) NOT NULL,
  config JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_videos INTEGER NOT NULL DEFAULT 0,
  completed_videos INTEGER NOT NULL DEFAULT 0,
  failed_videos INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS job_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  input_url VARCHAR(500) NOT NULL,
  video_id VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  source VARCHAR(50),
  language VARCHAR(20),
  title VARCHAR(512),
  channel VARCHAR(255),
  duration_seconds INTEGER,
  segment_count INTEGER,
  word_count INTEGER,
  credits_used INTEGER,
  cached BOOLEAN,
  error_code VARCHAR(50),
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_job_videos_job_id ON job_videos(job_id);
CREATE INDEX IF NOT EXISTS idx_job_videos_status ON job_videos(status);
CREATE INDEX IF NOT EXISTS idx_job_videos_video_id ON job_videos(video_id);

-- Forget that 013 ran, so a later `npm run db:migrate` re-applies it cleanly.
DELETE FROM _migrations WHERE filename = '013_transcript_queue.sql';

COMMIT;
```

- [ ] **Step 2: Commit**

```bash
git add backend/scripts/revert_013_transcript_queue.sql
git commit -m "chore(queue): add migration 013 revert SQL"
```

---

## Task 2: Write the revert runner and npm script

**Files:**
- Create: `backend/scripts/revert-013.ts`
- Modify: `backend/package.json`

- [ ] **Step 1: Write the runner**

Create `backend/scripts/revert-013.ts`:

```ts
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../src/db/pool';
import { logger } from '../src/config/logger';

/**
 * Runs the migration-013 rollback. The SQL file owns its own BEGIN/COMMIT,
 * so this runner just hands it to Postgres as one multi-statement query.
 *
 * Invoked via `npm run db:revert:013`. Deliberately separate from the
 * forward-only migration runner — it is never placed in db/migrations/.
 */
const SQL_FILE = path.join(__dirname, 'revert_013_transcript_queue.sql');

async function revert(): Promise<void> {
  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  logger.warn(
    'Reverting migration 013 — transcript_requests / transcript_batches will be DROPPED',
  );
  await pool.query(sql);
  logger.info('Migration 013 reverted; jobs / job_videos restored');
}

revert()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'Migration 013 revert failed');
    process.exit(1);
  });
```

- [ ] **Step 2: Add the npm script**

In `backend/package.json`, in `"scripts"`, after the `"db:migrate:prod"` line, add:

```json
    "db:revert:013": "ts-node-dev --transpile-only scripts/revert-013.ts",
```

- [ ] **Step 3: Verify it typechecks**

Run from `backend/`: `npm run typecheck`
Expected: no errors. (`pool` and `logger` are already exported from `src/db/pool.ts` and `src/config/logger.ts`.)

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/revert-013.ts backend/package.json
git commit -m "chore(queue): add db:revert:013 runner and npm script"
```

---

## Task 3: Verify the revert round-trips

No code changes — confirm the revert and re-migrate cycle works on a **dev/local database** (never run this verification against production).

- [ ] **Step 1: Confirm 013 is applied**

Run: `psql "$DATABASE_URL" -c '\dt transcript_requests' -c '\dt transcript_batches'`
Expected: both tables listed. If not, run `npm run db:migrate` first.

- [ ] **Step 2: Run the revert**

Run from `backend/`: `npm run db:revert:013`
Expected: log lines `Reverting migration 013 …` then `Migration 013 reverted; jobs / job_videos restored`.

- [ ] **Step 3: Confirm the schema is back to pre-013**

Run: `psql "$DATABASE_URL" -c '\dt jobs' -c '\dt job_videos' -c '\dt transcript_requests'`
Expected: `jobs` and `job_videos` are listed; `transcript_requests` is **not**. Also confirm the migration row is gone:
`psql "$DATABASE_URL" -c "SELECT 1 FROM _migrations WHERE filename = '013_transcript_queue.sql'"`
Expected: 0 rows.

- [ ] **Step 4: Confirm 013 re-applies cleanly**

Run from `backend/`: `npm run db:migrate`
Expected: `013_transcript_queue.sql` is applied again; `transcript_requests` / `transcript_batches` exist; `jobs` / `job_videos` are dropped again. This proves the revert leaves the database in a state the forward migration can re-process.

---

## Self-Review Notes

- **Scope:** one purpose — revert migration `013`. The SQL recreates `jobs` / `job_videos` verbatim from `010_jobs.sql` (FK order: drop `transcript_requests` before `transcript_batches`; create `jobs` before `job_videos`).
- **Consistency:** the npm script name `db:revert:013`, the SQL filename, and the runner's `SQL_FILE` path all agree. The runner does not wrap its own transaction — the SQL file owns `BEGIN`/`COMMIT`.
- **Re-applicability:** deleting the `_migrations` row is what lets `npm run db:migrate` re-run `013` afterward; Task 3 Step 4 verifies this.
- **Placement:** the revert lives in `backend/scripts/`, never `backend/src/db/migrations/`, so the forward runner never picks it up.
