import { redis } from '../cache/redis';
import { pool } from '../db/pool';
import { logger } from '../config/logger';
import { Segment } from './formatters';

export interface CachedTranscript {
  videoId: string;
  language: string;
  title: string;
  channel: string;
  durationSeconds: number;
  source: 'native_captions' | 'whisper';
  transcript: string;
  segments: Segment[];
  cachedAt: string;
}

const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function key(videoId: string, language: string): string {
  return `transcript:${videoId}:${language}`;
}

/**
 * Two-tier read: Redis hot cache, then Postgres cold cache.
 *
 * If Postgres has a row but Redis doesn't, we repopulate Redis (warm cache)
 * fire-and-forget so subsequent reads are fast again.
 */
export async function getCached(
  videoId: string,
  language: string,
): Promise<CachedTranscript | null> {
  try {
    const fromRedis = await redis.get(key(videoId, language));
    if (fromRedis) {
      try {
        return JSON.parse(fromRedis) as CachedTranscript;
      } catch (err) {
        logger.warn({ err, videoId }, 'Cache: corrupted Redis payload, ignoring');
      }
    }
  } catch (err) {
    // Redis is best-effort; fall through to Postgres if it's misbehaving.
    logger.warn({ err }, 'Cache: Redis lookup failed, trying Postgres');
  }

  const { rows } = await pool.query<{
    video_id: string;
    language: string;
    title: string | null;
    channel: string | null;
    duration_seconds: number | null;
    source: string | null;
    transcript_text: string;
    segments: Segment[];
    first_cached_at: Date;
  }>(
    `SELECT video_id, language, title, channel, duration_seconds, source,
            transcript_text, segments, first_cached_at
     FROM cached_transcripts
     WHERE video_id = $1 AND language = $2 AND expires_at > NOW()`,
    [videoId, language],
  );
  if (!rows.length) return null;

  const row = rows[0];
  const cached: CachedTranscript = {
    videoId: row.video_id,
    language: row.language,
    title: row.title ?? 'Untitled',
    channel: row.channel ?? 'Unknown',
    durationSeconds: row.duration_seconds ?? 0,
    source: (row.source as CachedTranscript['source']) ?? 'native_captions',
    transcript: row.transcript_text,
    segments: row.segments,
    cachedAt: row.first_cached_at.toISOString(),
  };

  // Update access stats + warm Redis. Both are best-effort.
  void pool
    .query(
      `UPDATE cached_transcripts
       SET last_accessed_at = NOW(), access_count = access_count + 1
       WHERE video_id = $1 AND language = $2`,
      [videoId, language],
    )
    .catch(() => {});
  void redis
    .setex(key(videoId, language), TTL_SECONDS, JSON.stringify(cached))
    .catch(() => {});

  return cached;
}

/**
 * Write-through cache.
 *
 * - Without `aliasLanguage` (the canonical write): Redis + Postgres are
 *   both written under `payload.language` (the actual returned language).
 * - With `aliasLanguage` (e.g. caching the same content under 'auto' for
 *   easy lookup later): we ONLY write to Redis. Postgres never stores an
 *   alias row, because the (video_id, language) PK there would force us to
 *   put the alias key in the `language` column and lie about what the
 *   transcript is actually in. If Redis later evicts the alias, an 'auto'
 *   request will miss and refetch — still cheap, and far better than
 *   serving Bangla content while claiming `language: 'auto'`.
 */
export async function setCached(
  payload: CachedTranscript,
  aliasLanguage?: string,
): Promise<void> {
  const videoId = payload.videoId;
  const language = aliasLanguage ?? payload.language;
  const isAlias = !!aliasLanguage;

  // Postgres write is skipped for alias keys — see the comment on this
  // function. The Redis write always happens so 'auto' lookups stay fast.
  const writes: Array<Promise<unknown>> = [
    redis.setex(key(videoId, language), TTL_SECONDS, JSON.stringify(payload)),
  ];
  if (!isAlias) {
    writes.push(
      pool.query(
        `INSERT INTO cached_transcripts
          (video_id, language, title, channel, duration_seconds, source,
           transcript_text, segments, character_count, segment_count, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + INTERVAL '30 days')
         ON CONFLICT (video_id, language) DO UPDATE
           SET title = EXCLUDED.title,
               channel = EXCLUDED.channel,
               duration_seconds = EXCLUDED.duration_seconds,
               source = EXCLUDED.source,
               transcript_text = EXCLUDED.transcript_text,
               segments = EXCLUDED.segments,
               character_count = EXCLUDED.character_count,
               segment_count = EXCLUDED.segment_count,
               last_accessed_at = NOW(),
               access_count = cached_transcripts.access_count + 1,
               expires_at = NOW() + INTERVAL '30 days'`,
        [
          videoId,
          language,
          payload.title,
          payload.channel,
          payload.durationSeconds,
          payload.source,
          payload.transcript,
          JSON.stringify(payload.segments),
          payload.transcript.length,
          payload.segments.length,
        ],
      ),
    );
  }

  const results = await Promise.allSettled(writes);
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn({ err: r.reason, videoId }, 'Cache: write failed (non-fatal)');
    }
  }
}
