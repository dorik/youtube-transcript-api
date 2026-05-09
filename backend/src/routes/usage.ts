import { Router } from 'express';
import { pool } from '../db/pool';
import { sessionAuth } from '../middleware/sessionAuth';

export const usageRouter = Router();

usageRouter.use(sessionAuth);

/**
 * Aggregated usage stats. Used by the dashboard overview/usage pages.
 *
 * - `totals` — request counts and credits spent over a few rolling windows.
 * - `by_source` — split between native_captions and Whisper for the month.
 * - `daily` — one row per day for the last 30 days, suitable for a chart.
 * - `recent` — most recent 25 requests for the activity table.
 */
usageRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.user!.id;

    const [totals, bySource, daily, recent] = await Promise.all([
      getTotals(userId),
      getBySource(userId),
      getDailyHistogram(userId),
      getRecent(userId),
    ]);

    res.json({ totals, by_source: bySource, daily, recent });
  } catch (err) {
    next(err);
  }
});

async function getTotals(userId: string) {
  const { rows } = await pool.query<{
    requests_today: number;
    requests_this_month: number;
    credits_used_today: number;
    credits_used_this_month: number;
    cache_hits_this_month: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::INT AS requests_today,
       COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()))::INT AS requests_this_month,
       COALESCE(SUM(credits_used) FILTER (WHERE created_at >= date_trunc('day', NOW())),0)::INT AS credits_used_today,
       COALESCE(SUM(credits_used) FILTER (WHERE created_at >= date_trunc('month', NOW())),0)::INT AS credits_used_this_month,
       COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()) AND cache_hit IS TRUE)::INT AS cache_hits_this_month
     FROM api_requests
     WHERE user_id = $1`,
    [userId],
  );
  return rows[0];
}

async function getBySource(userId: string) {
  const { rows } = await pool.query<{ source: string | null; count: number }>(
    `SELECT transcript_source AS source, COUNT(*)::INT AS count
     FROM api_requests
     WHERE user_id = $1
       AND created_at >= date_trunc('month', NOW())
       AND status_code = 200
     GROUP BY transcript_source`,
    [userId],
  );
  return rows;
}

async function getDailyHistogram(userId: string) {
  const { rows } = await pool.query<{ day: string; requests: number; credits: number }>(
    `WITH days AS (
       SELECT generate_series(
         date_trunc('day', NOW() - INTERVAL '29 days'),
         date_trunc('day', NOW()),
         INTERVAL '1 day'
       )::DATE AS day
     )
     SELECT
       to_char(d.day, 'YYYY-MM-DD') AS day,
       COALESCE(COUNT(r.id), 0)::INT AS requests,
       COALESCE(SUM(r.credits_used), 0)::INT AS credits
     FROM days d
     LEFT JOIN api_requests r
       ON r.user_id = $1
       AND r.created_at >= d.day
       AND r.created_at < d.day + INTERVAL '1 day'
     GROUP BY d.day
     ORDER BY d.day`,
    [userId],
  );
  return rows;
}

async function getRecent(userId: string) {
  const { rows } = await pool.query<{
    id: string;
    created_at: Date;
    method: string;
    endpoint: string;
    status_code: number;
    video_id: string | null;
    format: string | null;
    transcript_source: string | null;
    cache_hit: boolean | null;
    credits_used: number | null;
    response_time_ms: number | null;
    error_code: string | null;
  }>(
    `SELECT id, created_at, method, endpoint, status_code, video_id, format,
            transcript_source, cache_hit, credits_used, response_time_ms, error_code
     FROM api_requests
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 25`,
    [userId],
  );
  return rows;
}
