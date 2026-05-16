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
