import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../middleware/sessionAuth';
import { pool } from '../db/pool';

/**
 * `GET /me/transcripts` — paginated history of every video the user has
 * successfully fetched (via the API or the dashboard viewer).
 *
 * Source of truth is `api_requests`. We pick the most recent successful
 * request per video_id, then look up shared metadata from
 * `cached_transcripts` (title, channel, duration). One row per video.
 */
export const meTranscriptsRouter = Router();

meTranscriptsRouter.use(sessionAuth);

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().optional(),
});

interface HistoryRow {
  video_id: string;
  last_fetched_at: Date;
  fetch_count: number;
  format: string | null;
  language: string | null;
  transcript_source: string | null;
  cache_hit: boolean | null;
  credits_used: number | null;
  title: string | null;
  channel: string | null;
  duration_seconds: number | null;
  cached_language: string | null;
}

meTranscriptsRouter.get('/', async (req, res, next) => {
  try {
    const parsed = QuerySchema.parse(req.query);
    const userId = req.user!.id;

    // DISTINCT ON gives us the latest row per video; the LATERAL join then
    // attaches one row of cached metadata per video. The fetch_count is
    // computed in a subquery so it isn't affected by DISTINCT ON.
    const sql = `
      WITH latest AS (
        SELECT DISTINCT ON (video_id)
          video_id,
          format,
          language,
          transcript_source,
          cache_hit,
          credits_used,
          created_at AS last_fetched_at
        FROM api_requests
        WHERE user_id = $1
          AND video_id IS NOT NULL
          AND status_code = 200
        ORDER BY video_id, created_at DESC
      ),
      counts AS (
        SELECT video_id, COUNT(*)::int AS fetch_count
        FROM api_requests
        WHERE user_id = $1
          AND video_id IS NOT NULL
          AND status_code = 200
        GROUP BY video_id
      )
      SELECT
        l.video_id,
        l.last_fetched_at,
        c.fetch_count,
        l.format,
        l.language,
        l.transcript_source,
        l.cache_hit,
        l.credits_used,
        ct.title,
        ct.channel,
        ct.duration_seconds,
        ct.language AS cached_language
      FROM latest l
      JOIN counts c ON c.video_id = l.video_id
      LEFT JOIN LATERAL (
        SELECT title, channel, duration_seconds, language
        FROM cached_transcripts
        WHERE video_id = l.video_id
        ORDER BY first_cached_at ASC
        LIMIT 1
      ) ct ON TRUE
      WHERE ($4::text IS NULL OR ct.title ILIKE '%' || $4 || '%' OR ct.channel ILIKE '%' || $4 || '%' OR l.video_id ILIKE '%' || $4 || '%')
      ORDER BY l.last_fetched_at DESC
      LIMIT $2 OFFSET $3
    `;

    const { rows } = await pool.query<HistoryRow>(sql, [
      userId,
      parsed.limit,
      parsed.offset,
      parsed.q ?? null,
    ]);

    // Total count for pagination — separate query so we can use a similar
    // search filter without complicating the main query.
    const totalSql = `
      SELECT COUNT(DISTINCT ar.video_id)::int AS total
      FROM api_requests ar
      LEFT JOIN LATERAL (
        SELECT title, channel
        FROM cached_transcripts
        WHERE video_id = ar.video_id
        LIMIT 1
      ) ct ON TRUE
      WHERE ar.user_id = $1
        AND ar.video_id IS NOT NULL
        AND ar.status_code = 200
        AND ($2::text IS NULL OR ct.title ILIKE '%' || $2 || '%' OR ct.channel ILIKE '%' || $2 || '%' OR ar.video_id ILIKE '%' || $2 || '%')
    `;
    const { rows: totalRows } = await pool.query<{ total: number }>(totalSql, [
      userId,
      parsed.q ?? null,
    ]);

    res.json({
      items: rows.map((r) => ({
        video_id: r.video_id,
        title: r.title,
        channel: r.channel,
        duration_seconds: r.duration_seconds,
        language: r.cached_language,
        thumbnail_url: `https://img.youtube.com/vi/${r.video_id}/mqdefault.jpg`,
        last_fetched_at: r.last_fetched_at,
        fetch_count: r.fetch_count,
        last_format: r.format,
        last_source: r.transcript_source,
        last_cache_hit: r.cache_hit,
        last_credits_used: r.credits_used,
      })),
      total: totalRows[0]?.total ?? 0,
      limit: parsed.limit,
      offset: parsed.offset,
    });
  } catch (err) {
    next(err);
  }
});
