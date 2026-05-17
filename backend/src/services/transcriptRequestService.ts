import { pool, withTransaction } from '../db/pool';
import { OutputFormat } from './formatters';
import { TranscriptResponse } from './transcriptService';
import { extractVideoId } from '../utils/youtubeUrl';
import { getCreditState } from './creditService';
import { PaymentRequiredError, ApiError, ConflictError } from '../utils/errors';
import {
  enqueueTranscriptJob,
  removeTranscriptJob,
} from '../queue/transcriptQueue';
import { logger } from '../config/logger';
import { getCached } from './cacheService';
import { normalizeLanguageCode } from '../utils/languageCodes';

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
  /** Batch metadata for every batch referenced by `items`, so the caller can
   *  render a batch header (kind, label, video count) without a per-batch
   *  detail fetch. */
  batches: BatchRow[];
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

  const batchIds = [
    ...new Set(
      rows.map((r) => r.batch_id).filter((id): id is string => Boolean(id)),
    ),
  ];
  let batches: BatchRow[] = [];
  if (batchIds.length > 0) {
    const { rows: batchRows } = await pool.query<BatchRow>(
      `SELECT id, user_id, kind, source_url, label, total, created_at
       FROM transcript_batches
       WHERE id = ANY($1::uuid[]) AND user_id = $2`,
      [batchIds, userId],
    );
    batches = batchRows;
  }

  return {
    items: rows,
    total: Number(countRows[0]?.total ?? 0),
    batches,
  };
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
       AND COALESCE((request->>'native_only')::boolean, false) = $6
     ORDER BY (status = 'completed'), created_at DESC
     LIMIT 1`,
    [
      userId,
      videoId,
      cfg.format,
      cfg.language ?? '',
      cfg.translate_to ?? '',
      cfg.native_only ?? false,
    ],
  );
  return rows[0] ?? null;
}

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
  // Advisory best-effort gate: balance and pending-count are read here
  // WITHOUT a transaction lock, so two concurrent requests can both pass
  // this check simultaneously. The authoritative enforcement is the
  // worker-time deductCredits(), which uses SELECT ... FOR UPDATE and
  // throws PaymentRequiredError (classified as permanent → row marked
  // `failed` with INSUFFICIENT_CREDITS). Under a concurrency race a user
  // may therefore end up with a few rows in `failed` status rather than
  // receiving a clean 402 at enqueue time. This is an accepted trade-off.
  if (balance - pending < 1) {
    throw new PaymentRequiredError(1, balance - pending);
  }

  const { rows } = await pool.query<TranscriptRequestRow>(
    `INSERT INTO transcript_requests (user_id, source, status, request, video_id)
     VALUES ($1, $2, 'queued', $3, $4)
     RETURNING ${ROW_COLUMNS}`,
    [input.userId, input.source, JSON.stringify(input.config), videoId],
  );
  const row = rows[0];

  // A Redis enqueue cannot be rolled back inside the Postgres INSERT above.
  // If enqueue (or the job-id write-back) fails, mark the row `failed` so it
  // does not sit `queued` forever with no BullMQ job behind it.
  try {
    const jobId = await enqueueTranscriptJob(row.id);
    await pool.query(
      `UPDATE transcript_requests SET bullmq_job_id = $1 WHERE id = $2`,
      [jobId, row.id],
    );
    row.bullmq_job_id = jobId;
    return row;
  } catch (err) {
    await pool
      .query(
        `UPDATE transcript_requests
         SET status = 'failed', error_code = 'ENQUEUE_FAILED',
             error_message = $2, completed_at = NOW()
         WHERE id = $1`,
        [
          row.id,
          err instanceof Error ? err.message.slice(0, 500) : 'enqueue failed',
        ],
      )
      .catch(() => undefined);
    throw err;
  }
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
    throw new ConflictError(
      `A request that is ${row.status} cannot be canceled.`,
      'NOT_CANCELABLE',
    );
  }
  if (row.bullmq_job_id) await removeTranscriptJob(row.bullmq_job_id);
  // Conditional on the row still being `queued` — closes the race where the
  // worker promotes it to `processing` between the read above and this
  // UPDATE. Zero rows matched ⇒ the worker won the race.
  const { rows } = await pool.query<TranscriptRequestRow>(
    `UPDATE transcript_requests
     SET status = 'canceled', completed_at = NOW()
     WHERE id = $1 AND status = 'queued' RETURNING ${ROW_COLUMNS}`,
    [id],
  );
  if (!rows[0]) {
    throw new ConflictError(
      'This request started processing before it could be canceled.',
      'NOT_CANCELABLE',
    );
  }
  return rows[0];
}

export interface CancelBatchResult {
  batch: BatchRow;
  canceledCount: number;
}

/**
 * Cancel every still-`queued` child of a batch. Rows already
 * `processing`/`completed`/`failed`/`canceled` are left untouched — in-flight
 * work cannot be force-killed. Scoped to the owning user.
 */
export async function cancelBatch(
  id: string,
  userId: string,
): Promise<CancelBatchResult | null> {
  const batch = await getBatch(id, userId);
  if (!batch) return null;

  // Conditional on each child still being `queued` — closes the race where
  // the worker promotes a row to `processing` between the batch lookup and
  // this UPDATE. Only rows that were still `queued` at UPDATE time are
  // returned (and thus get their BullMQ job removed).
  const { rows } = await pool.query<
    Pick<TranscriptRequestRow, 'id' | 'bullmq_job_id'>
  >(
    `UPDATE transcript_requests
     SET status = 'canceled', completed_at = NOW()
     WHERE batch_id = $1 AND status = 'queued'
     RETURNING id, bullmq_job_id`,
    [batch.id],
  );

  // Best-effort job removal. Note the ordering differs deliberately from
  // cancelRequest: here the conditional UPDATE runs *first*, so `rows` holds
  // only children confirmed still `queued` at commit time — removing their
  // jobs cannot race a worker that already owns one. A job the worker has
  // already picked up cannot be removed, but it re-checks the row's
  // `canceled` status before doing work.
  for (const row of rows) {
    if (row.bullmq_job_id) await removeTranscriptJob(row.bullmq_job_id);
  }

  return { batch, canceledCount: rows.length };
}

// ---------------------------------------------------------------------------
// Worker-facing status mutations
// ---------------------------------------------------------------------------

export async function markProcessing(
  id: string,
  attempt: number,
): Promise<void> {
  await pool.query(
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
  await pool.query(
    `UPDATE transcript_requests
     SET title = $2, channel = $3, duration_seconds = $4, thumbnail_url = $5
     WHERE id = $1`,
    [id, meta.title, meta.channel, meta.durationSeconds, meta.thumbnailUrl],
  );
}

export async function markCompleted(
  id: string,
  result: TranscriptResponse,
): Promise<void> {
  await pool.query(
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
  await pool.query(
    `UPDATE transcript_requests
     SET status = 'failed', error_code = $2, error_message = $3,
         completed_at = NOW()
     WHERE id = $1`,
    [id, errorCode, errorMessage.slice(0, 1000)],
  );
}

/**
 * Best-effort api_requests log row, written by the worker so dashboard usage
 * charts keep capturing every request. Never throws.
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
    await pool.query(
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

// ---------------------------------------------------------------------------
// Batch progress + retention queries
// ---------------------------------------------------------------------------

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
  const { rows } = await pool.query<BatchRow>(
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
  const { rows } = await pool.query<{ status: RequestStatus; n: string }>(
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
  const { rows } = await pool.query<TranscriptRequestRow>(
    `SELECT ${ROW_COLUMNS} FROM transcript_requests
     WHERE batch_id = $1 ORDER BY batch_position ASC`,
    [batchId],
  );
  return rows;
}

/** Delete batches + standalone requests older than `days`. Returns row count. */
export async function purgeOldRequests(days = 30): Promise<number> {
  const batch = await pool.query(
    `DELETE FROM transcript_batches WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  const single = await pool.query(
    `DELETE FROM transcript_requests
     WHERE batch_id IS NULL AND created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return (batch.rowCount ?? 0) + (single.rowCount ?? 0);
}

// ---------------------------------------------------------------------------
// Batch enqueue
// ---------------------------------------------------------------------------

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

  // Normalize the language exactly as getTranscript does before any cache
  // lookup, so that a non-canonical caller value (e.g. 'english') resolves to
  // the same cache key ('en') that the worker will use when it runs
  // getTranscript. Without this, cache hits on non-canonical language strings
  // are invisible to the pre-check and the user is incorrectly charged a
  // credit that getTranscript would never have billed.
  const rawLang = input.config.language;
  const language =
    rawLang && rawLang.trim() && rawLang !== 'auto'
      ? normalizeLanguageCode(rawLang) || rawLang.trim()
      : 'auto';
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
  // Advisory best-effort gate: balance and pending-count are read here
  // WITHOUT a transaction lock, so two concurrent batch submissions can
  // both pass this check simultaneously. The authoritative enforcement is
  // the worker-time deductCredits(), which uses SELECT ... FOR UPDATE and
  // throws PaymentRequiredError (classified as permanent → row marked
  // `failed` with INSUFFICIENT_CREDITS). Under a concurrency race a user
  // may therefore end up with a few rows in `failed` status rather than
  // receiving a clean 402 at enqueue time. This is an accepted trade-off.
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
      const status: RequestStatus = cachedFlags[i] ? 'completed' : 'queued';
      const { rows } = await client.query<TranscriptRequestRow>(
        `INSERT INTO transcript_requests
           (user_id, source, status, request, video_id, title, channel,
            duration_seconds, thumbnail_url, batch_id, batch_position,
            completed_at)
         VALUES ($1,'dashboard',$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 CASE WHEN $11 THEN NOW() ELSE NULL END)
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
          status === 'completed',
        ],
      );
      requests.push(rows[0]);
    }
    return { batch, requests };
  });

  for (const row of created.requests) {
    if (row.status === 'queued') {
      const jobId = await enqueueTranscriptJob(row.id);
      await pool.query(
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
