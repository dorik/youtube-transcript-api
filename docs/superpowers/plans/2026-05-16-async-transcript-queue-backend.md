# Async Transcript Queue — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transcript requests asynchronous — `POST` enqueues a BullMQ job and returns immediately; an in-process worker runs the existing transcript pipeline; clients poll status by id.

**Architecture:** A new `transcript_requests` table (one row per request) plus `transcript_batches` (bulk grouping) backs a BullMQ queue on the existing Redis. A BullMQ `Worker` runs inside the Express process and calls the unchanged `getTranscript()` service. Routes change from do-work-and-return to validate-gate-enqueue.

**Tech Stack:** Node.js, Express, TypeScript, PostgreSQL (`pg`), Redis (`ioredis`), BullMQ, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-16-async-transcript-queue-design.md`

**Scope note:** This plan covers the backend only. The dashboard UI (queue panel, batch grouping) is a separate follow-up plan that depends on this one being merged.

---

## File Structure

**Create:**
- `backend/src/db/migrations/013_transcript_queue.sql` — schema for `transcript_requests` + `transcript_batches`; drops dead `jobs`/`job_videos`.
- `backend/src/queue/connection.ts` — dedicated ioredis connection for BullMQ.
- `backend/src/queue/transcriptQueue.ts` — the `Queue`, enqueue/remove helpers.
- `backend/src/queue/worker.ts` — the `Worker`, job processor, retention job, `startWorker()`.
- `backend/src/services/errorClassification.ts` — `classifyError()` (transient vs permanent).
- `backend/src/services/errorClassification.test.ts` — unit tests.
- `backend/src/services/transcriptRequestService.ts` — DB layer + enqueue-gate orchestration for requests and batches.
- `backend/src/services/transcriptRequestService.test.ts` — unit tests for gate logic.
- `backend/src/routes/meTranscripts.ts` — **rewritten**: list + create + get + cancel + bulk under `/me/transcripts`.

**Modify:**
- `backend/package.json` — add `bullmq`.
- `backend/src/config/env.ts` — add `QUEUE_CONCURRENCY`.
- `backend/src/routes/transcript.ts` — `/v1/transcript` becomes async (enqueue + poll).
- `backend/src/index.ts` — call `startWorker()` on boot.
- `backend/src/app.ts` — drop the `meTranscriptRouter` (singular) mount; keep `meTranscriptsRouter`.
- `backend/src/services/transcriptService.ts` — remove the now-dead `runBulkTranscripts` and its bulk types.
- `backend/src/routes/youtubeBrowse.ts` — remove the two synchronous bulk endpoints that used `runBulkTranscripts`.

**Delete:**
- `backend/src/routes/meTranscript.ts` — the singular synchronous route is superseded.

---

## Task 1: Install BullMQ and add the concurrency env var

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/src/config/env.ts`

- [ ] **Step 1: Install BullMQ**

Run from `backend/`:

```bash
npm install bullmq
```

Expected: `package.json` `dependencies` gains a `bullmq` entry (v5.x).

- [ ] **Step 2: Add `QUEUE_CONCURRENCY` to the env schema**

In `backend/src/config/env.ts`, inside the `EnvSchema` object, after the `RATE_LIMIT_REQUESTS_PER_MIN` line, add:

```ts
  /**
   * How many transcript jobs the in-process BullMQ worker runs in parallel.
   * Kept low (2) because each job can spawn yt-dlp + ffmpeg + Whisper, which
   * is memory-heavy on the 512 MB Render instance.
   */
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
```

- [ ] **Step 3: Verify it typechecks**

Run from `backend/`: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/config/env.ts
git commit -m "chore(queue): add bullmq dependency and QUEUE_CONCURRENCY env"
```

---

## Task 2: Database migration

**Files:**
- Create: `backend/src/db/migrations/013_transcript_queue.sql`

- [ ] **Step 1: Write the migration**

Create `backend/src/db/migrations/013_transcript_queue.sql`:

```sql
-- Async transcript queue.
--
-- transcript_requests : one row per transcript request (single or batch child).
-- transcript_batches  : groups the rows of a bulk playlist/channel submission.
--
-- This supersedes the never-used jobs / job_videos tables (migration 010),
-- which are dropped here. The migration runner wraps each file in one
-- transaction, so the DROP + CREATE statements below are atomic together.

DROP TABLE IF EXISTS job_videos;
DROP TABLE IF EXISTS jobs;

CREATE TABLE IF NOT EXISTS transcript_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        VARCHAR(10) NOT NULL,            -- 'playlist' | 'channel' | 'videos'
  source_url  VARCHAR(500),
  label       VARCHAR(512),
  total       INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transcript_batches_user
  ON transcript_batches(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transcript_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source           VARCHAR(10) NOT NULL,       -- 'api' | 'dashboard'
  status           VARCHAR(12) NOT NULL DEFAULT 'queued',
                                               -- queued|processing|completed|failed|canceled
  request          JSONB NOT NULL,            -- { url, format, language,
                                               --   native_only, translate_to }
  video_id         VARCHAR(20),
  title            VARCHAR(512),
  channel          VARCHAR(255),
  duration_seconds INTEGER,
  thumbnail_url    VARCHAR(500),
  bullmq_job_id    VARCHAR(64),
  attempts         INTEGER NOT NULL DEFAULT 0,
  result           JSONB,                      -- full TranscriptResponse; set on completion
  credits_used     INTEGER,
  error_code       VARCHAR(50),
  error_message    TEXT,
  batch_id         UUID REFERENCES transcript_batches(id) ON DELETE CASCADE,
  batch_position   INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transcript_requests_user
  ON transcript_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_requests_status
  ON transcript_requests(status);
CREATE INDEX IF NOT EXISTS idx_transcript_requests_batch
  ON transcript_requests(batch_id);
```

- [ ] **Step 2: Run the migration**

Run from `backend/` (requires `DATABASE_URL` in `backend/.env`):

```bash
npm run db:migrate
```

Expected: log line `Applying migration { file: '013_transcript_queue.sql' }` then `Migrations complete`.

- [ ] **Step 3: Verify the tables exist**

Run: `psql "$DATABASE_URL" -c '\d transcript_requests' -c '\d transcript_batches'`
Expected: both tables print their columns; `\d jobs` would now error (dropped).

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/migrations/013_transcript_queue.sql
git commit -m "feat(queue): add transcript_requests + transcript_batches tables"
```

---

## Task 3: BullMQ connection and queue module

**Files:**
- Create: `backend/src/queue/connection.ts`
- Create: `backend/src/queue/transcriptQueue.ts`

- [ ] **Step 1: Write the dedicated Redis connection**

Create `backend/src/queue/connection.ts`:

```ts
import IORedis from 'ioredis';
import { config } from '../config/env';
import { logger } from '../config/logger';

/**
 * BullMQ requires its own ioredis connection with `maxRetriesPerRequest: null`
 * — it issues long-lived blocking commands and manages retries itself. The
 * cache client in src/cache/redis.ts keeps `maxRetriesPerRequest: 3`; the two
 * must NOT be shared.
 */
export const queueConnection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});

queueConnection.on('error', (err) => {
  logger.error({ err }, 'Queue Redis connection error');
});
```

- [ ] **Step 2: Write the queue module**

Create `backend/src/queue/transcriptQueue.ts`:

```ts
import { Queue } from 'bullmq';
import { queueConnection } from './connection';

export const TRANSCRIPT_QUEUE_NAME = 'transcript-requests';

/** Job name for a single transcript request. */
export const JOB_TRANSCRIBE = 'transcribe';
/** Job name for the daily retention sweep. */
export const JOB_CLEANUP = 'cleanup';

export interface TranscriptJobData {
  requestId: string;
}

export const transcriptQueue = new Queue(TRANSCRIPT_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/** Enqueue one transcript request; returns the BullMQ job id. */
export async function enqueueTranscriptJob(requestId: string): Promise<string> {
  const job = await transcriptQueue.add(JOB_TRANSCRIBE, { requestId });
  return job.id!;
}

/** Remove a not-yet-active job (used to cancel a queued request). */
export async function removeTranscriptJob(jobId: string): Promise<void> {
  const job = await transcriptQueue.getJob(jobId);
  if (job) await job.remove().catch(() => undefined);
}
```

- [ ] **Step 3: Verify it typechecks**

Run from `backend/`: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/queue/connection.ts backend/src/queue/transcriptQueue.ts
git commit -m "feat(queue): add BullMQ connection and queue module"
```

---

## Task 4: Error classification helper

**Files:**
- Create: `backend/src/services/errorClassification.ts`
- Test: `backend/src/services/errorClassification.test.ts`

The worker must retry transient failures and fail permanent ones immediately.

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/errorClassification.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyError } from './errorClassification';
import {
  NoTranscriptError,
  UpgradeRequiredError,
  UpstreamBlockedError,
  ValidationError,
  PaymentRequiredError,
} from '../utils/errors';

describe('classifyError', () => {
  it('treats UpstreamBlockedError as transient', () => {
    expect(classifyError(new UpstreamBlockedError('blocked'))).toBe('transient');
  });

  it('treats a generic network error as transient', () => {
    expect(classifyError(new Error('socket hang up'))).toBe('transient');
  });

  it('treats NoTranscriptError as permanent', () => {
    expect(classifyError(new NoTranscriptError('no captions'))).toBe('permanent');
  });

  it('treats UpgradeRequiredError as permanent', () => {
    expect(classifyError(new UpgradeRequiredError('AI transcription'))).toBe('permanent');
  });

  it('treats ValidationError as permanent', () => {
    expect(classifyError(new ValidationError('bad url'))).toBe('permanent');
  });

  it('treats PaymentRequiredError as permanent', () => {
    expect(classifyError(new PaymentRequiredError(1, 0))).toBe('permanent');
  });
});
```

Note: confirm `UpstreamBlockedError` and `NoTranscriptError` constructor signatures in `backend/src/utils/errors.ts` before running; adjust the test arguments to match.

- [ ] **Step 2: Run the test to verify it fails**

Run from `backend/`: `npx vitest run src/services/errorClassification.test.ts`
Expected: FAIL — `classifyError` is not defined.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/errorClassification.ts`:

```ts
import {
  NoTranscriptError,
  UpgradeRequiredError,
  ValidationError,
  PaymentRequiredError,
  UpstreamBlockedError,
} from '../utils/errors';

export type ErrorKind = 'transient' | 'permanent';

/**
 * Decide whether a worker failure should be retried.
 *
 * - permanent: re-running will fail the same way (no captions, bad input, the
 *   user can't pay). The worker fails the job immediately, no retry.
 * - transient: a retry has a real chance of succeeding (YouTube blocked our
 *   IP, a network blip). BullMQ retries with backoff.
 *
 * Default is transient — an unrecognized error is more likely a blip than a
 * deterministic dead end, and BullMQ caps retries at 3 anyway.
 */
export function classifyError(err: unknown): ErrorKind {
  if (
    err instanceof NoTranscriptError ||
    err instanceof UpgradeRequiredError ||
    err instanceof ValidationError ||
    err instanceof PaymentRequiredError
  ) {
    return 'permanent';
  }
  if (err instanceof UpstreamBlockedError) {
    return 'transient';
  }
  return 'transient';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `backend/`: `npx vitest run src/services/errorClassification.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/errorClassification.ts backend/src/services/errorClassification.test.ts
git commit -m "feat(queue): add transient/permanent error classification"
```

---

## Task 5: Transcript request service — types and DB layer

**Files:**
- Create: `backend/src/services/transcriptRequestService.ts`

This task adds the data-access layer. The enqueue-gate orchestration is added in Task 6; the worker helpers in Task 7.

- [ ] **Step 1: Write the types and row-level CRUD**

Create `backend/src/services/transcriptRequestService.ts`:

```ts
import { pool } from '../db/pool';
import { OutputFormat } from './formatters';
import { TranscriptResponse } from './transcriptService';

export type RequestStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled';

/** The user-supplied parameters, stored as JSONB on the row. */
export interface TranscriptRequestConfig {
  url: string;
  format: OutputFormat;
  language?: string;
  native_only?: boolean;
  translate_to?: string;
}

export interface TranscriptRequestRow {
  id: string;
  user_id: string;
  source: 'api' | 'dashboard';
  status: RequestStatus;
  request: TranscriptRequestConfig;
  video_id: string | null;
  title: string | null;
  channel: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  bullmq_job_id: string | null;
  attempts: number;
  result: TranscriptResponse | null;
  credits_used: number | null;
  error_code: string | null;
  error_message: string | null;
  batch_id: string | null;
  batch_position: number | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

const ROW_COLUMNS = `
  id, user_id, source, status, request, video_id, title, channel,
  duration_seconds, thumbnail_url, bullmq_job_id, attempts, result,
  credits_used, error_code, error_message, batch_id, batch_position,
  created_at, started_at, completed_at
`;

export async function getRequestById(
  id: string,
): Promise<TranscriptRequestRow | null> {
  const { rows } = await pool.query<TranscriptRequestRow>(
    `SELECT ${ROW_COLUMNS} FROM transcript_requests WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Scoped read used by routes — never returns another user's row. */
export async function getUserRequest(
  id: string,
  userId: string,
): Promise<TranscriptRequestRow | null> {
  const { rows } = await pool.query<TranscriptRequestRow>(
    `SELECT ${ROW_COLUMNS} FROM transcript_requests
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export interface ListRequestsResult {
  items: TranscriptRequestRow[];
  total: number;
}

export async function listUserRequests(
  userId: string,
  limit: number,
  offset: number,
): Promise<ListRequestsResult> {
  const { rows } = await pool.query<TranscriptRequestRow>(
    `SELECT ${ROW_COLUMNS} FROM transcript_requests
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::int AS total FROM transcript_requests WHERE user_id = $1`,
    [userId],
  );
  return { items: rows, total: Number(countRows[0]?.total ?? 0) };
}

/** Count of the user's not-yet-finished requests (for the gate + cap). */
export async function countPendingRequests(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM transcript_requests
     WHERE user_id = $1 AND status IN ('queued', 'processing')`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Find a non-failed, non-canceled request for the same user + video + params,
 * newest first. Used for de-dup: a queued/processing match prevents duplicate
 * work; a completed match is an instant, free re-serve.
 */
export async function findDuplicateRequest(
  userId: string,
  videoId: string,
  cfg: TranscriptRequestConfig,
): Promise<TranscriptRequestRow | null> {
  const { rows } = await pool.query<TranscriptRequestRow>(
    `SELECT ${ROW_COLUMNS} FROM transcript_requests
     WHERE user_id = $1
       AND video_id = $2
       AND status IN ('queued', 'processing', 'completed')
       AND request->>'format' = $3
       AND COALESCE(request->>'language', '') = $4
       AND COALESCE(request->>'translate_to', '') = $5
     ORDER BY (status = 'completed'), created_at DESC
     LIMIT 1`,
    [
      userId,
      videoId,
      cfg.format,
      cfg.language ?? '',
      cfg.translate_to ?? '',
    ],
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 2: Verify it typechecks**

Run from `backend/`: `npm run typecheck`
Expected: no errors. (`TranscriptResponse` is already exported from `transcriptService.ts`.)

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/transcriptRequestService.ts
git commit -m "feat(queue): add transcript request DB layer"
```

---

## Task 6: Enqueue gate — single request and batch

**Files:**
- Modify: `backend/src/services/transcriptRequestService.ts`
- Test: `backend/src/services/transcriptRequestService.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/transcriptRequestService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../db/pool', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
  withTransaction: async (fn: (c: unknown) => unknown) =>
    fn({ query: (...a: unknown[]) => queryMock(...a) }),
}));

const creditMock = vi.hoisted(() => ({ getCreditState: vi.fn() }));
vi.mock('./creditService', () => creditMock);

const queueMock = vi.hoisted(() => ({
  enqueueTranscriptJob: vi.fn().mockResolvedValue('job-1'),
}));
vi.mock('../queue/transcriptQueue', () => queueMock);

import { enqueueSingleRequest } from './transcriptRequestService';
import { PaymentRequiredError } from '../utils/errors';

beforeEach(() => {
  queryMock.mockReset();
  creditMock.getCreditState.mockReset();
  queueMock.enqueueTranscriptJob.mockClear();
});

describe('enqueueSingleRequest', () => {
  it('rejects with PaymentRequiredError when balance minus pending < 1', async () => {
    creditMock.getCreditState.mockResolvedValue({ balance: 1 });
    // findDuplicate -> none; countPending -> 1
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // findDuplicateRequest
      .mockResolvedValueOnce({ rows: [{ n: 1 }] }); // countPendingRequests

    await expect(
      enqueueSingleRequest({
        userId: 'u1',
        source: 'dashboard',
        config: { url: 'https://youtu.be/dQw4w9WgXcQ', format: 'json' },
      }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(queueMock.enqueueTranscriptJob).not.toHaveBeenCalled();
  });

  it('returns the existing row when a duplicate is found', async () => {
    const existing = { id: 'r-existing', status: 'queued' };
    queryMock.mockResolvedValueOnce({ rows: [existing] }); // findDuplicateRequest

    const result = await enqueueSingleRequest({
      userId: 'u1',
      source: 'dashboard',
      config: { url: 'https://youtu.be/dQw4w9WgXcQ', format: 'json' },
    });

    expect(result.id).toBe('r-existing');
    expect(queueMock.enqueueTranscriptJob).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `backend/`: `npx vitest run src/services/transcriptRequestService.test.ts`
Expected: FAIL — `enqueueSingleRequest` is not exported.

- [ ] **Step 3: Implement the single-request gate**

Append to `backend/src/services/transcriptRequestService.ts`:

```ts
import { extractVideoId } from '../utils/youtubeUrl';
import { getCreditState } from './creditService';
import { PaymentRequiredError, ApiError } from '../utils/errors';
import {
  enqueueTranscriptJob,
  removeTranscriptJob,
} from '../queue/transcriptQueue';
import { pool as dbPool } from '../db/pool';

/** Max queued+processing requests a single user may hold at once. */
export const PENDING_REQUEST_CAP = 200;

export class TooManyPendingError extends ApiError {
  constructor(cap: number) {
    super(
      429,
      'TOO_MANY_PENDING',
      'too_many_requests',
      `You already have the maximum of ${cap} requests in the queue. Wait for some to finish.`,
      { pending_cap: cap },
    );
  }
}

export interface EnqueueSingleInput {
  userId: string;
  source: 'api' | 'dashboard';
  config: TranscriptRequestConfig;
}

/**
 * Validate, gate on credits + pending cap, de-dup, then insert a queued row
 * and add the BullMQ job. Returns the row the caller should respond with —
 * either a freshly created `queued` row or an existing duplicate.
 */
export async function enqueueSingleRequest(
  input: EnqueueSingleInput,
): Promise<TranscriptRequestRow> {
  // extractVideoId throws ValidationError on a malformed URL.
  const videoId = extractVideoId(input.config.url);

  const duplicate = await findDuplicateRequest(
    input.userId,
    videoId,
    input.config,
  );
  if (duplicate) return duplicate;

  const [{ balance }, pending] = await Promise.all([
    getCreditState(input.userId),
    countPendingRequests(input.userId),
  ]);

  if (pending >= PENDING_REQUEST_CAP) {
    throw new TooManyPendingError(PENDING_REQUEST_CAP);
  }
  if (balance - pending < 1) {
    throw new PaymentRequiredError(1, balance - pending);
  }

  const { rows } = await dbPool.query<TranscriptRequestRow>(
    `INSERT INTO transcript_requests (user_id, source, status, request, video_id)
     VALUES ($1, $2, 'queued', $3, $4)
     RETURNING ${ROW_COLUMNS}`,
    [input.userId, input.source, JSON.stringify(input.config), videoId],
  );
  const row = rows[0];

  const jobId = await enqueueTranscriptJob(row.id);
  await dbPool.query(
    `UPDATE transcript_requests SET bullmq_job_id = $1 WHERE id = $2`,
    [jobId, row.id],
  );
  row.bullmq_job_id = jobId;
  return row;
}

/**
 * Cancel a queued request. Only `queued` rows can be canceled — a row already
 * `processing` cannot have its yt-dlp/Whisper run force-killed.
 */
export async function cancelRequest(
  id: string,
  userId: string,
): Promise<TranscriptRequestRow | null> {
  const row = await getUserRequest(id, userId);
  if (!row) return null;
  if (row.status !== 'queued') {
    throw new ApiError(
      409,
      'NOT_CANCELABLE',
      'conflict',
      `A request that is ${row.status} cannot be canceled.`,
    );
  }
  if (row.bullmq_job_id) await removeTranscriptJob(row.bullmq_job_id);
  const { rows } = await dbPool.query<TranscriptRequestRow>(
    `UPDATE transcript_requests
     SET status = 'canceled', completed_at = NOW()
     WHERE id = $1 RETURNING ${ROW_COLUMNS}`,
    [id],
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `backend/`: `npx vitest run src/services/transcriptRequestService.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/transcriptRequestService.ts backend/src/services/transcriptRequestService.test.ts
git commit -m "feat(queue): add single-request enqueue gate and cancel"
```

---

## Task 7: Worker-side helpers and batch enqueue

**Files:**
- Modify: `backend/src/services/transcriptRequestService.ts`

- [ ] **Step 1: Add the worker-facing status mutations**

Append to `backend/src/services/transcriptRequestService.ts`:

```ts
import { logger } from '../config/logger';
import type { TranscriptResponse as TResponse } from './transcriptService';

export async function markProcessing(
  id: string,
  attempt: number,
): Promise<void> {
  await dbPool.query(
    `UPDATE transcript_requests
     SET status = 'processing', attempts = $2,
         started_at = COALESCE(started_at, NOW())
     WHERE id = $1`,
    [id, attempt],
  );
}

export async function setMetadata(
  id: string,
  meta: {
    title: string | null;
    channel: string | null;
    durationSeconds: number | null;
    thumbnailUrl: string | null;
  },
): Promise<void> {
  await dbPool.query(
    `UPDATE transcript_requests
     SET title = $2, channel = $3, duration_seconds = $4, thumbnail_url = $5
     WHERE id = $1`,
    [id, meta.title, meta.channel, meta.durationSeconds, meta.thumbnailUrl],
  );
}

export async function markCompleted(
  id: string,
  result: TResponse,
): Promise<void> {
  await dbPool.query(
    `UPDATE transcript_requests
     SET status = 'completed', result = $2, credits_used = $3,
         video_id = COALESCE(video_id, $4),
         title = COALESCE(title, $5), channel = COALESCE(channel, $6),
         duration_seconds = COALESCE(duration_seconds, $7),
         completed_at = NOW()
     WHERE id = $1`,
    [
      id,
      JSON.stringify(result),
      result.credits_used,
      result.video_id,
      result.title,
      result.channel,
      result.duration,
    ],
  );
}

export async function markFailed(
  id: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await dbPool.query(
    `UPDATE transcript_requests
     SET status = 'failed', error_code = $2, error_message = $3,
         completed_at = NOW()
     WHERE id = $1`,
    [id, errorCode, errorMessage.slice(0, 1000)],
  );
}

/**
 * Best-effort api_requests log row, written by the worker so dashboard usage
 * charts keep capturing every request. Mirrors the columns the old
 * synchronous routes wrote. Never throws.
 */
export async function logApiRequest(input: {
  userId: string;
  endpoint: string;
  statusCode: number;
  videoId: string | null;
  format: string | null;
  language: string | null;
  transcriptSource: string | null;
  cacheHit: boolean | null;
  creditsUsed: number | null;
  errorCode: string | null;
}): Promise<void> {
  try {
    await dbPool.query(
      `INSERT INTO api_requests
        (user_id, method, endpoint, status_code, video_id, format, language,
         transcript_source, cache_hit, credits_used, error_code)
       VALUES ($1,'POST',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.userId,
        input.endpoint,
        input.statusCode,
        input.videoId,
        input.format,
        input.language,
        input.transcriptSource,
        input.cacheHit,
        input.creditsUsed,
        input.errorCode,
      ],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to log api_requests row from worker');
  }
}
```

- [ ] **Step 2: Add batch progress + retention queries**

Append to `backend/src/services/transcriptRequestService.ts`:

```ts
export interface BatchRow {
  id: string;
  user_id: string;
  kind: 'playlist' | 'channel' | 'videos';
  source_url: string | null;
  label: string | null;
  total: number;
  created_at: Date;
}

export interface BatchProgress {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  canceled: number;
}

export async function getBatch(
  id: string,
  userId: string,
): Promise<BatchRow | null> {
  const { rows } = await dbPool.query<BatchRow>(
    `SELECT id, user_id, kind, source_url, label, total, created_at
     FROM transcript_batches WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/** Derive per-status counts for a batch — no counter columns to drift. */
export async function getBatchProgress(
  batchId: string,
): Promise<BatchProgress> {
  const { rows } = await dbPool.query<{ status: RequestStatus; n: string }>(
    `SELECT status, COUNT(*)::int AS n
     FROM transcript_requests WHERE batch_id = $1 GROUP BY status`,
    [batchId],
  );
  const progress: BatchProgress = {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
  };
  for (const r of rows) progress[r.status] = Number(r.n);
  return progress;
}

export async function listBatchRequests(
  batchId: string,
): Promise<TranscriptRequestRow[]> {
  const { rows } = await dbPool.query<TranscriptRequestRow>(
    `SELECT ${ROW_COLUMNS} FROM transcript_requests
     WHERE batch_id = $1 ORDER BY batch_position ASC`,
    [batchId],
  );
  return rows;
}

/** Delete batches + standalone requests older than `days`. Returns row count. */
export async function purgeOldRequests(days = 30): Promise<number> {
  // Deleting a batch cascades to its child requests.
  const batch = await dbPool.query(
    `DELETE FROM transcript_batches WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  const single = await dbPool.query(
    `DELETE FROM transcript_requests
     WHERE batch_id IS NULL AND created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return (batch.rowCount ?? 0) + (single.rowCount ?? 0);
}
```

- [ ] **Step 3: Add the batch enqueue function**

Append to `backend/src/services/transcriptRequestService.ts`:

```ts
import { getCached } from './cacheService';
import { withTransaction } from '../db/pool';

/** Max videos a single bulk submission may contain. */
export const BATCH_VIDEO_CAP = 100;

export class BatchTooLargeError extends ApiError {
  constructor(count: number, cap: number) {
    super(
      400,
      'BATCH_TOO_LARGE',
      'invalid_request',
      `This batch has ${count} videos; the maximum is ${cap}. Split it into smaller batches.`,
      { count, cap },
    );
  }
}

export interface BatchVideoInput {
  url: string;
  video_id: string;
  title?: string | null;
  channel?: string | null;
  thumbnail_url?: string | null;
  duration_seconds?: number | null;
}

export interface EnqueueBatchInput {
  userId: string;
  kind: 'playlist' | 'channel' | 'videos';
  sourceUrl: string | null;
  label: string | null;
  videos: BatchVideoInput[];
  config: Omit<TranscriptRequestConfig, 'url'>;
}

export interface EnqueueBatchResult {
  batch: BatchRow;
  requests: TranscriptRequestRow[];
}

/**
 * Expand a bulk submission into one batch + one row per video. Videos already
 * cached for the requested params are inserted directly as `completed` (0
 * credits, no queue job); the rest are queued. The whole batch is rejected if
 * the user cannot afford every uncached video.
 */
export async function enqueueBatch(
  input: EnqueueBatchInput,
): Promise<EnqueueBatchResult> {
  if (input.videos.length === 0) {
    throw new ApiError(
      400,
      'EMPTY_BATCH',
      'invalid_request',
      'The playlist/channel expanded to zero videos.',
    );
  }
  if (input.videos.length > BATCH_VIDEO_CAP) {
    throw new BatchTooLargeError(input.videos.length, BATCH_VIDEO_CAP);
  }

  // Cache pre-check: which videos already have a cached transcript for the
  // requested language? Those become instant `completed` rows.
  const language = input.config.language ?? 'auto';
  const cachedFlags = await Promise.all(
    input.videos.map(async (v) => {
      try {
        return Boolean(await getCached(v.video_id, language));
      } catch {
        return false;
      }
    }),
  );
  const uncachedCount = cachedFlags.filter((c) => !c).length;

  const [{ balance }, pending] = await Promise.all([
    getCreditState(input.userId),
    countPendingRequests(input.userId),
  ]);
  if (pending + uncachedCount > PENDING_REQUEST_CAP) {
    throw new TooManyPendingError(PENDING_REQUEST_CAP);
  }
  if (balance - pending < uncachedCount) {
    throw new PaymentRequiredError(uncachedCount, balance - pending);
  }

  const created = await withTransaction(async (client) => {
    const { rows: batchRows } = await client.query<BatchRow>(
      `INSERT INTO transcript_batches (user_id, kind, source_url, label, total)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, kind, source_url, label, total, created_at`,
      [
        input.userId,
        input.kind,
        input.sourceUrl,
        input.label,
        input.videos.length,
      ],
    );
    const batch = batchRows[0];

    const requests: TranscriptRequestRow[] = [];
    for (let i = 0; i < input.videos.length; i++) {
      const v = input.videos[i];
      const cfg: TranscriptRequestConfig = { ...input.config, url: v.url };
      // Cached videos go straight to `completed`; the worker never sees them.
      const status: RequestStatus = cachedFlags[i] ? 'completed' : 'queued';
      const { rows } = await client.query<TranscriptRequestRow>(
        `INSERT INTO transcript_requests
           (user_id, source, status, request, video_id, title, channel,
            duration_seconds, thumbnail_url, batch_id, batch_position,
            completed_at)
         VALUES ($1,'dashboard',$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END)
         RETURNING ${ROW_COLUMNS}`,
        [
          input.userId,
          status,
          JSON.stringify(cfg),
          v.video_id,
          v.title ?? null,
          v.channel ?? null,
          v.duration_seconds ?? null,
          v.thumbnail_url ?? null,
          batch.id,
          i,
        ],
      );
      requests.push(rows[0]);
    }
    return { batch, requests };
  });

  // Enqueue jobs for the non-cached rows; log api_requests for the cached ones.
  for (const row of created.requests) {
    if (row.status === 'queued') {
      const jobId = await enqueueTranscriptJob(row.id);
      await dbPool.query(
        `UPDATE transcript_requests SET bullmq_job_id = $1 WHERE id = $2`,
        [jobId, row.id],
      );
      row.bullmq_job_id = jobId;
    } else {
      await logApiRequest({
        userId: input.userId,
        endpoint: '/me/transcripts/bulk',
        statusCode: 200,
        videoId: row.video_id,
        format: row.request.format,
        language: row.request.language ?? null,
        transcriptSource: null,
        cacheHit: true,
        creditsUsed: 0,
        errorCode: null,
      });
    }
  }
  return created;
}
```

- [ ] **Step 4: Verify it typechecks**

Run from `backend/`: `npm run typecheck`
Expected: no errors. If `getCached`'s signature differs from `getCached(videoId, language)`, open `backend/src/services/cacheService.ts` and adjust the call.

- [ ] **Step 5: Run the existing tests to confirm no regression**

Run from `backend/`: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/transcriptRequestService.ts
git commit -m "feat(queue): add worker status helpers and batch enqueue"
```

---

## Task 8: The BullMQ worker

**Files:**
- Create: `backend/src/queue/worker.ts`

- [ ] **Step 1: Write the worker**

Create `backend/src/queue/worker.ts`:

```ts
import { Worker, UnrecoverableError, Job } from 'bullmq';
import { queueConnection } from './connection';
import {
  TRANSCRIPT_QUEUE_NAME,
  JOB_TRANSCRIBE,
  JOB_CLEANUP,
  TranscriptJobData,
  transcriptQueue,
} from './transcriptQueue';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { getTranscript } from '../services/transcriptService';
import { fetchYouTubeMetadata } from '../services/youtubeService';
import { buildWatchUrl } from '../utils/youtubeUrl';
import { classifyError } from '../services/errorClassification';
import { ApiError } from '../utils/errors';
import * as svc from '../services/transcriptRequestService';

async function processTranscribe(job: Job<TranscriptJobData>): Promise<void> {
  const { requestId } = job.data;
  const req = await svc.getRequestById(requestId);
  if (!req) {
    logger.warn({ requestId }, 'Transcript request row missing; dropping job');
    return;
  }
  if (req.status === 'canceled') {
    logger.info({ requestId }, 'Request canceled before processing; skipping');
    return;
  }

  const attempt = job.attemptsMade + 1;
  await svc.markProcessing(requestId, attempt);

  // Step 1: cheap metadata so the row renders before transcription finishes.
  if (req.video_id && !req.title) {
    try {
      const meta = await fetchYouTubeMetadata(req.video_id);
      await svc.setMetadata(requestId, {
        title: meta.title,
        channel: meta.channel,
        durationSeconds: meta.durationSeconds ?? null,
        thumbnailUrl: `https://img.youtube.com/vi/${req.video_id}/mqdefault.jpg`,
      });
    } catch (err) {
      logger.info({ err, requestId }, 'Metadata prefetch failed; continuing');
    }
  }

  // Step 2: the real transcript work — unchanged orchestration.
  try {
    const result = await getTranscript({
      userId: req.user_id,
      url: req.request.url,
      format: req.request.format,
      language: req.request.language,
      nativeOnly: req.request.native_only,
      translateTo: req.request.translate_to,
    });
    await svc.markCompleted(requestId, result);
    await svc.logApiRequest({
      userId: req.user_id,
      endpoint: req.source === 'api' ? '/v1/transcript' : '/me/transcripts',
      statusCode: 200,
      videoId: result.video_id,
      format: req.request.format,
      language: req.request.language ?? null,
      transcriptSource: result.source,
      cacheHit: result.cached,
      creditsUsed: result.credits_used,
      errorCode: null,
    });
  } catch (err) {
    // Permanent failures must not be retried; transient ones are re-thrown
    // so BullMQ retries. The DB row is marked `failed` by the worker's
    // `failed` event handler — which fires only on the final, exhausted
    // attempt — so retries in between leave the row as `processing`.
    if (classifyError(err) === 'permanent') {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new UnrecoverableError(message);
    }
    logger.warn(
      { err, requestId, attempt },
      'Transient transcript failure; BullMQ will retry if attempts remain',
    );
    throw err;
  }
}

async function processCleanup(): Promise<void> {
  const purged = await svc.purgeOldRequests(30);
  logger.info({ purged }, 'Transcript retention sweep complete');
}

let worker: Worker<TranscriptJobData> | null = null;

/**
 * Start the in-process BullMQ worker and register the daily retention job.
 * Idempotent — calling twice is a no-op.
 */
export async function startWorker(): Promise<void> {
  if (worker) return;

  worker = new Worker<TranscriptJobData>(
    TRANSCRIPT_QUEUE_NAME,
    async (job) => {
      if (job.name === JOB_CLEANUP) return processCleanup();
      return processTranscribe(job);
    },
    { connection: queueConnection, concurrency: config.QUEUE_CONCURRENCY },
  );

  // Fires only when a job has truly failed (retries exhausted, or thrown as
  // UnrecoverableError). This is the single place the DB row goes `failed`.
  worker.on('failed', async (job, err) => {
    if (!job || job.name !== JOB_TRANSCRIBE) {
      logger.error({ err, job: job?.name }, 'Queue job failed');
      return;
    }
    const requestId = job.data.requestId;
    try {
      const req = await svc.getRequestById(requestId);
      if (!req || req.status === 'canceled' || req.status === 'completed') {
        return;
      }
      const code =
        err instanceof ApiError
          ? err.code
          : err instanceof UnrecoverableError
            ? 'PERMANENT_FAILURE'
            : 'INTERNAL_ERROR';
      const message = err?.message ?? 'Unknown error';
      await svc.markFailed(requestId, code, message);
      await svc.logApiRequest({
        userId: req.user_id,
        endpoint: req.source === 'api' ? '/v1/transcript' : '/me/transcripts',
        statusCode: err instanceof ApiError ? err.status : 500,
        videoId: req.video_id,
        format: req.request.format,
        language: req.request.language ?? null,
        transcriptSource: null,
        cacheHit: null,
        creditsUsed: 0,
        errorCode: code,
      });
    } catch (handlerErr) {
      logger.error({ handlerErr, requestId }, 'Failed to record job failure');
    }
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'BullMQ worker error');
  });

  // Daily retention sweep. `jobId` keeps the repeatable job unique across
  // restarts so we don't accumulate duplicate schedules.
  await transcriptQueue.add(
    JOB_CLEANUP,
    {},
    { repeat: { pattern: '0 3 * * *' }, jobId: 'retention-sweep' },
  );

  logger.info(
    { concurrency: config.QUEUE_CONCURRENCY },
    'Transcript worker started',
  );
}

export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
```

Note: `buildWatchUrl` is imported only if used; if the final code does not reference it, remove the import to satisfy `noUnusedLocals`. Verify `fetchYouTubeMetadata`'s return shape in `backend/src/services/youtubeService.ts` — adjust `meta.durationSeconds` if the property name differs.

- [ ] **Step 2: Verify it typechecks**

Run from `backend/`: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/queue/worker.ts
git commit -m "feat(queue): add in-process BullMQ worker with retry + retention"
```

---

## Task 9: Start the worker on boot

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Start the worker in `main()`**

Replace the body of `main()` in `backend/src/index.ts` so it reads:

```ts
import 'dotenv/config';
import { createApp } from './app';
import { config } from './config/env';
import { logger } from './config/logger';
import { startWorker } from './queue/worker';

async function main() {
  const app = createApp();

  // The BullMQ worker runs in this same process (see design doc — Render's
  // free tier has no separate worker service). Started before listen() so a
  // boot-time queue failure surfaces immediately.
  await startWorker();

  app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      `Server listening on http://localhost:${config.PORT}`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the server boots**

Run from `backend/` (requires Redis + Postgres reachable): `npm run dev`
Expected: log lines `Transcript worker started` and `Server listening on ...`. Stop with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(queue): start the transcript worker on server boot"
```

---

## Task 10: Rewrite `/me/transcripts` — list, create, get, cancel

**Files:**
- Create (replace): `backend/src/routes/meTranscripts.ts`
- Delete: `backend/src/routes/meTranscript.ts`
- Modify: `backend/src/app.ts`

- [ ] **Step 1: Replace the router**

Overwrite `backend/src/routes/meTranscripts.ts` with:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../middleware/sessionAuth';
import { VALID_FORMATS, OutputFormat } from '../services/formatters';
import { ValidationError } from '../utils/errors';
import * as svc from '../services/transcriptRequestService';

/**
 * `/me/transcripts` — cookie-authed async transcript queue for the dashboard.
 *
 *   POST   /me/transcripts            enqueue one request
 *   POST   /me/transcripts/bulk       enqueue a playlist/channel/list batch
 *   GET    /me/transcripts            list the user's requests
 *   GET    /me/transcripts/batches/:id  batch summary + entries
 *   GET    /me/transcripts/:id        one request
 *   DELETE /me/transcripts/:id        cancel a queued request
 *
 * Literal sub-paths are registered before the `/:id` param route.
 */
export const meTranscriptsRouter = Router();
meTranscriptsRouter.use(sessionAuth);

const CreateSchema = z.object({
  url: z.string().min(1, 'url is required'),
  format: z
    .enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]])
    .default('json'),
  language: z.string().min(2).max(10).optional(),
  native_only: z.boolean().optional(),
  translate_to: z.string().min(2).max(10).optional(),
});

meTranscriptsRouter.post('/', async (req, res, next) => {
  try {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const row = await svc.enqueueSingleRequest({
      userId: req.user!.id,
      source: 'dashboard',
      config: parsed.data,
    });
    res.status(row.status === 'queued' ? 202 : 200).json(row);
  } catch (err) {
    next(err);
  }
});

const ListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

meTranscriptsRouter.get('/', async (req, res, next) => {
  try {
    const { limit, offset } = ListSchema.parse(req.query);
    const result = await svc.listUserRequests(req.user!.id, limit, offset);
    res.json({ ...result, limit, offset });
  } catch (err) {
    next(err);
  }
});

meTranscriptsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await svc.getUserRequest(req.params.id, req.user!.id);
    if (!row) {
      res.status(404).json({ error: 'not_found', code: 'NOT_FOUND' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

meTranscriptsRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await svc.cancelRequest(req.params.id, req.user!.id);
    if (!row) {
      res.status(404).json({ error: 'not_found', code: 'NOT_FOUND' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});
```

(The `/bulk` and `/batches/:id` routes are added in Task 11; they must be registered *before* `/:id` — Task 11 specifies exactly where.)

- [ ] **Step 2: Delete the superseded singular route file**

```bash
git rm backend/src/routes/meTranscript.ts
```

- [ ] **Step 3: Update `app.ts`**

In `backend/src/app.ts`, remove the import line `import { meTranscriptRouter } from './routes/meTranscript';` and the mount line `app.use('/me/transcript', meTranscriptRouter);`. Leave the `meTranscriptsRouter` import and its `app.use('/me/transcripts', meTranscriptsRouter);` mount in place.

- [ ] **Step 4: Verify it typechecks**

Run from `backend/`: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Start the server (`npm run dev`), then with a valid session cookie:

```bash
curl -i -X POST http://localhost:3001/me/transcripts \
  -H 'Content-Type: application/json' -b 'yt_session=...' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ","format":"json"}'
```

Expected: `202` with a JSON body whose `status` is `queued`. Then `GET /me/transcripts` lists it; within a minute its `status` becomes `completed` and `result` is populated.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/meTranscripts.ts backend/src/app.ts
git commit -m "feat(queue): async /me/transcripts list/create/get/cancel"
```

---

## Task 11: Bulk route and batch route

**Files:**
- Modify: `backend/src/routes/meTranscripts.ts`
- Reference: `backend/src/services/youtubeBrowseService.ts` (`listPlaylistVideos`, `listChannelVideos`)

- [ ] **Step 1: Add the bulk + batch routes**

In `backend/src/routes/meTranscripts.ts`, add this import:

```ts
import {
  listPlaylistVideos,
  listChannelVideos,
} from '../services/youtubeBrowseService';
import { extractVideoId } from '../utils/youtubeUrl';
```

Then, **before** the `meTranscriptsRouter.get('/:id', ...)` route, add:

```ts
const BulkSchema = z.object({
  // Exactly one of these identifies the batch source.
  playlist: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  urls: z.array(z.string().min(1)).min(1).max(svc.BATCH_VIDEO_CAP).optional(),
  format: z
    .enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]])
    .default('json'),
  language: z.string().min(2).max(10).optional(),
  native_only: z.boolean().optional(),
  translate_to: z.string().min(2).max(10).optional(),
  limit: z.coerce.number().int().min(1).max(svc.BATCH_VIDEO_CAP).default(50),
});

meTranscriptsRouter.post('/bulk', async (req, res, next) => {
  try {
    const parsed = BulkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const p = parsed.data;
    const config = {
      format: p.format,
      language: p.language,
      native_only: p.native_only,
      translate_to: p.translate_to,
    };

    let kind: 'playlist' | 'channel' | 'videos';
    let sourceUrl: string | null = null;
    let label: string | null = null;
    let videos: svc.BatchVideoInput[];

    if (p.playlist) {
      kind = 'playlist';
      sourceUrl = p.playlist;
      const listing = await listPlaylistVideos({
        playlist: p.playlist,
        limit: p.limit,
      });
      videos = listing.items.map((v) => ({
        url: v.url,
        video_id: v.video_id,
        title: v.title,
        channel: v.channel,
        thumbnail_url: v.thumbnail_url,
      }));
    } else if (p.channel) {
      kind = 'channel';
      sourceUrl = p.channel;
      label = p.channel;
      const listing = await listChannelVideos({
        channel: p.channel,
        limit: p.limit,
      });
      videos = listing.items.map((v) => ({
        url: v.url,
        video_id: v.video_id,
        title: v.title,
        channel: v.channel,
        thumbnail_url: v.thumbnail_url,
      }));
    } else if (p.urls) {
      kind = 'videos';
      videos = p.urls.map((url) => ({ url, video_id: extractVideoId(url) }));
    } else {
      throw new ValidationError('Provide one of: playlist, channel, urls');
    }

    const result = await svc.enqueueBatch({
      userId: req.user!.id,
      kind,
      sourceUrl,
      label,
      videos,
      config,
    });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

meTranscriptsRouter.get('/batches/:id', async (req, res, next) => {
  try {
    const batch = await svc.getBatch(req.params.id, req.user!.id);
    if (!batch) {
      res.status(404).json({ error: 'not_found', code: 'NOT_FOUND' });
      return;
    }
    const [progress, requests] = await Promise.all([
      svc.getBatchProgress(batch.id),
      svc.listBatchRequests(batch.id),
    ]);
    res.json({ batch, progress, requests });
  } catch (err) {
    next(err);
  }
});
```

Note: confirm `listPlaylistVideos` / `listChannelVideos` return `items` of `BrowseVideo` with `video_id`, `url`, `title`, `channel`, `thumbnail_url` (they do, per `youtubeBrowseService.ts`). `BrowseVideo` has no numeric duration, so `duration_seconds` is left unset — the worker fills it.

- [ ] **Step 2: Verify it typechecks**

Run from `backend/`: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verification**

```bash
curl -i -X POST http://localhost:3001/me/transcripts/bulk \
  -H 'Content-Type: application/json' -b 'yt_session=...' \
  -d '{"playlist":"https://www.youtube.com/playlist?list=PL...","limit":5,"format":"json"}'
```

Expected: `202` with `{ batch, requests }`; `requests` has up to 5 rows. `GET /me/transcripts/batches/<batch.id>` returns derived `progress` counts that move from `queued` to `completed` over time.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/meTranscripts.ts
git commit -m "feat(queue): add bulk playlist/channel enqueue + batch route"
```

---

## Task 12: Make `/v1/transcript` async

**Files:**
- Modify: `backend/src/routes/transcript.ts`

- [ ] **Step 1: Rewrite the route**

Overwrite `backend/src/routes/transcript.ts` with:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { apiKeyAuth } from '../middleware/apiKeyAuth';
import { rateLimit } from '../middleware/rateLimit';
import { VALID_FORMATS, OutputFormat } from '../services/formatters';
import { ValidationError } from '../utils/errors';
import * as svc from '../services/transcriptRequestService';

/**
 * `/v1/transcript` — public, API-key-authed transcript queue.
 *
 *   POST /v1/transcript         enqueue a request, returns 202 + entry
 *   GET  /v1/transcript/:id     poll one entry
 *
 * Async-only: enqueue returns instantly. To transcribe a playlist, a consumer
 * loops POST per video URL — there is no API bulk endpoint (see design doc).
 *
 * BREAKING CHANGE vs. the old synchronous GET /v1/transcript.
 */
export const transcriptRouter = Router();

const CreateSchema = z.object({
  url: z.string().min(1, 'url is required'),
  format: z
    .enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]])
    .default('json'),
  language: z.string().min(2).max(10).optional(),
  native_only: z.boolean().optional(),
  translate_to: z.string().min(2).max(10).optional(),
});

transcriptRouter.post(
  '/transcript',
  apiKeyAuth,
  rateLimit,
  async (req, res, next) => {
    try {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', {
          issues: parsed.error.flatten().fieldErrors,
        });
      }
      const row = await svc.enqueueSingleRequest({
        userId: req.user!.id,
        source: 'api',
        config: parsed.data,
      });
      res.status(row.status === 'queued' ? 202 : 200).json(row);
    } catch (err) {
      next(err);
    }
  },
);

transcriptRouter.get(
  '/transcript/:id',
  apiKeyAuth,
  rateLimit,
  async (req, res, next) => {
    try {
      const row = await svc.getUserRequest(req.params.id, req.user!.id);
      if (!row) {
        res.status(404).json({ error: 'not_found', code: 'NOT_FOUND' });
        return;
      }
      res.json(row);
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 2: Verify it typechecks**

Run from `backend/`: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verification**

```bash
curl -i -X POST http://localhost:3001/v1/transcript \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer yt_live_...' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'
```

Expected: `202` + a queued entry. `GET /v1/transcript/<id>` polls it to `completed`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/transcript.ts
git commit -m "feat(queue)!: make /v1/transcript async (enqueue + poll)"
```

---

## Task 13: Remove the dead synchronous bulk code

**Files:**
- Modify: `backend/src/services/transcriptService.ts`
- Modify: `backend/src/routes/youtubeBrowse.ts`

- [ ] **Step 1: Remove `runBulkTranscripts` and its bulk types**

In `backend/src/services/transcriptService.ts`, delete the entire "Bulk transcripts" section — from the `// ---` bulk header comment block through the end of the file (`runBulkTranscripts`, `makeFailureItem`, `toBulkError`, the `BULK_CONCURRENCY` const, and the `BulkVideoInput` / `BulkTranscriptOptions` / `BulkTranscriptError` / `BulkTranscriptItem` / `BulkTranscriptResult` interfaces).

- [ ] **Step 2: Remove the synchronous bulk endpoints**

In `backend/src/routes/youtubeBrowse.ts`:
- Delete the `runBulkTranscripts` import.
- Delete the `youtubeBrowseRouter.get('/playlist/transcripts', ...)` handler and its `PlaylistTranscriptsSchema`.
- Delete the `youtubeBrowseRouter.get('/channel/transcripts', ...)` handler and its `ChannelTranscriptsSchema`.
- Delete the now-unused `BulkLimitSchema`, `FormatSchema`, and `NativeOnlySchema` consts if nothing else references them (the discovery endpoints do not).

- [ ] **Step 3: Verify it typechecks**

Run from `backend/`: `npm run typecheck`
Expected: no errors. Fix any remaining references the compiler flags.

- [ ] **Step 4: Run the full test suite**

Run from `backend/`: `npm test`
Expected: all tests PASS. If `youtubeService.test.ts` or `transcriptService` tests referenced bulk symbols, update them.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/transcriptService.ts backend/src/routes/youtubeBrowse.ts
git commit -m "refactor(queue): remove synchronous runBulkTranscripts (superseded by queue)"
```

---

## Task 14: Render Redis eviction-policy guard

**Files:**
- Modify: `backend/src/queue/worker.ts`

- [ ] **Step 1: Add a startup eviction-policy check**

In `backend/src/queue/worker.ts`, inside `startWorker()`, after the `worker = new Worker(...)` assignment and before the `transcriptQueue.add(JOB_CLEANUP, ...)` call, add:

```ts
  // BullMQ silently loses jobs if Redis evicts keys. Render's free Key Value
  // datastore can default to an eviction policy other than noeviction — warn
  // loudly so the operator fixes it in the Render dashboard.
  try {
    const policy = await queueConnection.config('GET', 'maxmemory-policy');
    const value = Array.isArray(policy) ? policy[1] : undefined;
    if (value && value !== 'noeviction') {
      logger.warn(
        { maxmemoryPolicy: value },
        'Redis maxmemory-policy is not "noeviction" — queued jobs may be evicted. Set it to noeviction.',
      );
    }
  } catch (err) {
    logger.info({ err }, 'Could not read Redis maxmemory-policy (non-fatal)');
  }
```

- [ ] **Step 2: Verify it typechecks and boots**

Run from `backend/`: `npm run typecheck` then `npm run dev`
Expected: no type errors; server boots; if local Redis is not `noeviction` the warning prints.

- [ ] **Step 3: Commit**

```bash
git add backend/src/queue/worker.ts
git commit -m "feat(queue): warn at startup if Redis eviction policy risks job loss"
```

---

## Task 15: End-to-end verification

No code changes — verify the whole backend before handing off to the frontend plan.

- [ ] **Step 1: Full typecheck + tests**

Run from `backend/`: `npm run typecheck && npm test`
Expected: no type errors; all tests PASS.

- [ ] **Step 2: Single-request happy path**

Start `npm run dev`. `POST /me/transcripts` with a captioned video. Expected: `202` queued → polling `GET /me/transcripts/:id` shows `processing` → `completed` with `result` populated and `credits_used` is `0` or `1`.

- [ ] **Step 3: Duplicate de-dup**

`POST /me/transcripts` the same URL+format twice quickly. Expected: the second response has the **same `id`** as the first; no second job runs.

- [ ] **Step 4: Permanent failure**

`POST /me/transcripts` with a malformed URL. Expected: `400 VALIDATION_ERROR` at enqueue (never enters the queue). `POST` a real video with no captions on a free-plan user. Expected: the entry reaches `status: failed` with an `error_code`, no retry storm in the logs.

- [ ] **Step 5: Credit gate**

As a user with `balance` 0, `POST /me/transcripts`. Expected: `402 INSUFFICIENT_CREDITS`.

- [ ] **Step 6: Bulk batch**

`POST /me/transcripts/bulk` with a small playlist. Expected: `202` with N request rows; `GET /me/transcripts/batches/:id` progress counts converge to `completed`.

- [ ] **Step 7: Cancel**

`POST` a request, then immediately `DELETE /me/transcripts/:id` while it is still `queued`. Expected: `200`, status `canceled`; the worker logs `Request canceled before processing; skipping` if it later dequeues the job.

- [ ] **Step 8: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(queue): backend end-to-end verification fixes"
```

---

## Self-Review Notes

- **Spec coverage:** migration + drop (Task 2), BullMQ in-process worker + concurrency (Tasks 1, 3, 8, 9), gate-at-enqueue/charge-on-success — credit deduction stays inside `getTranscript`, gate in Task 6 (Tasks 6, 12), unified list (Task 10), bulk fan-out + batches (Tasks 7, 11), retry policy (Tasks 4, 8), 200 cap / 100 batch cap (Tasks 6, 7), retention (Tasks 7, 8), de-dup (Tasks 5, 6, 7), Redis eviction warning (Task 14), `runBulkTranscripts` removal (Task 13). All spec sections map to a task.
- **Naming consistency:** the service module is `transcriptRequestService` everywhere; the worker imports it as `svc`. Status strings (`queued`/`processing`/`completed`/`failed`/`canceled`) are consistent across migration, service, worker, and routes.
- **Frontend** (queue panel, batch UI, viewer changes) is intentionally out of this plan — it is the follow-up plan and depends on these endpoints existing.
