import { redis } from '../cache/redis';
import { pool, withTransaction } from '../db/pool';
import { logger } from '../config/logger';
import { Segment } from './formatters';

export interface CachedTranscript {
  videoId: string;
  language: string;
  title: string | null;
  channel: string | null;
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

function translationKey(
  videoId: string,
  sourceLanguage: string,
  targetLanguage: string,
): string {
  return `translation:${videoId}:${sourceLanguage}:${targetLanguage}`;
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

  type Row = {
    video_id: string;
    language: string;
    title: string | null;
    channel: string | null;
    duration_seconds: number | null;
    source: string | null;
    transcript_text: string;
    segments: Segment[];
    first_cached_at: Date;
  };

  let rows: Row[];
  ({ rows } = await pool.query<Row>(
    `SELECT video_id, language, title, channel, duration_seconds, source,
            transcript_text, segments, first_cached_at
     FROM cached_transcripts
     WHERE video_id = $1 AND language = $2 AND expires_at > NOW()`,
    [videoId, language],
  ));

  // Auto-language fallback: if the user asked for `auto` and we didn't
  // find an exact-language row, return ANY cached language for this video.
  // This lets production (cold Redis) benefit from Postgres entries that
  // local dev populated under the actual returned language (e.g. 'bn'),
  // instead of cache-missing and trying to fetch from YouTube — which
  // datacenter IPs (Render) get blocked from.
  if (rows.length === 0 && language === 'auto') {
    ({ rows } = await pool.query<Row>(
      `SELECT video_id, language, title, channel, duration_seconds, source,
              transcript_text, segments, first_cached_at
       FROM cached_transcripts
       WHERE video_id = $1 AND expires_at > NOW()
       ORDER BY first_cached_at ASC
       LIMIT 1`,
      [videoId],
    ));
  }

  if (!rows.length) return null;

  const row = rows[0];

  const cached: CachedTranscript = {
    videoId: row.video_id,
    language: row.language,
    title: row.title,
    channel: row.channel,
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
           SET title = COALESCE(EXCLUDED.title, cached_transcripts.title),
               channel = COALESCE(EXCLUDED.channel, cached_transcripts.channel),
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

// ---------------------------------------------------------------------------
// Cache invalidation
//
// `clearCache(videoId?)` clears transcript content from Redis + Postgres for
// either a single video or every entry. `cached_transcripts` rows are kept
// and their metadata (title/channel/duration) preserved — only the transcript
// columns are cleared. `translated_transcripts` is fully removed. Rate-limit
// keys (`ratelimit:*`) are deliberately left alone — they self-expire in 60s.
//
// Counts are returned so the caller can report meaningful telemetry rather
// than "ok".
// ---------------------------------------------------------------------------

export interface ClearCacheResult {
  scope: 'all' | 'video';
  videoId: string | null;
  redis: { transcripts: number; translations: number };
  postgres: { cached_transcripts: number; translated_transcripts: number };
}

async function scanDelete(pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      500,
    );
    cursor = next;
    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');
  return deleted;
}

/**
 * Shared SET clause: clears the transcript CONTENT columns and expires the
 * row, while deliberately NOT touching `title` / `channel` /
 * `duration_seconds`. Those metadata columns must outlive a flush so
 * `/me/transcripts` can still render title/channel/duration.
 *
 * `expires_at = NOW()` makes the row fail `getCached`'s `expires_at > NOW()`
 * filter, so the next request cache-misses and re-fetches the transcript.
 *
 * `transcript_text` is set to `''` (not NULL) to satisfy its NOT NULL
 * constraint — a reader that bypasses the `expires_at` guard should treat an
 * empty string as "content cleared".
 */
const CLEAR_TRANSCRIPT_SET = `
  SET transcript_text = '',
      segments        = '[]'::jsonb,
      character_count = 0,
      segment_count   = 0,
      expires_at      = NOW()`;

/**
 * Clear transcript content from the Postgres cache while preserving video
 * metadata. `cached_transcripts` is UPDATEd in place (not dropped);
 * `translated_transcripts` holds no metadata so it is truncated outright.
 * Runs in one transaction; returns pre-existing counts for telemetry
 * (`cached_transcripts` = rows whose transcript was cleared).
 */
async function invalidateCacheTables(): Promise<{
  cached_transcripts: number;
  translated_transcripts: number;
}> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM translated_transcripts',
    );
    const { rowCount: invalidated } = await client.query(
      `UPDATE cached_transcripts ${CLEAR_TRANSCRIPT_SET}`,
    );
    await client.query('TRUNCATE translated_transcripts RESTART IDENTITY');
    return {
      cached_transcripts: invalidated ?? 0,
      translated_transcripts: Number(rows[0]?.count ?? 0),
    };
  });
}

export async function clearCache(videoId?: string): Promise<ClearCacheResult> {
  if (videoId) {
    // Targeted clear: invalidate this video's transcript but keep its
    // metadata row. translated_transcripts has no metadata, so DELETE it.
    const t = await scanDelete(`transcript:${videoId}:*`);
    const tr = await scanDelete(`translation:${videoId}:*`);
    const { rowCount: ct } = await pool.query(
      `UPDATE cached_transcripts ${CLEAR_TRANSCRIPT_SET} WHERE video_id = $1`,
      [videoId],
    );
    const { rowCount: tt } = await pool.query(
      'DELETE FROM translated_transcripts WHERE video_id = $1',
      [videoId],
    );
    return {
      scope: 'video',
      videoId,
      redis: { transcripts: t, translations: tr },
      postgres: { cached_transcripts: ct ?? 0, translated_transcripts: tt ?? 0 },
    };
  }

  // Full flush. Use SCAN (non-blocking) so a large keyspace doesn't lock
  // Redis while it runs.
  const t = await scanDelete('transcript:*');
  const tr = await scanDelete('translation:*');

  const postgres = await invalidateCacheTables();

  return {
    scope: 'all',
    videoId: null,
    redis: { transcripts: t, translations: tr },
    postgres,
  };
}

export interface FlushAllResult {
  /** Number of Redis keys that existed before the FLUSHALL. */
  redis: { keysDeleted: number };
  postgres: { cached_transcripts: number; translated_transcripts: number };
}

/**
 * Hard reset of the cache.
 *
 * Runs Redis `FLUSHALL`, wiping the WHOLE Redis instance (`ratelimit:*` keys
 * included — they rebuild on the next request and self-expire in 60s).
 *
 * The Postgres side clears only transcript CONTENT: `cached_transcripts` rows
 * are UPDATEd in place so video metadata (title/channel/duration) survives,
 * and `translated_transcripts` is truncated. Without this Postgres half, the
 * cold tier would re-warm Redis with the old transcripts on the next read.
 */
export async function flushAllCache(): Promise<FlushAllResult> {
  // Snapshot the key count before the wipe so the caller gets a meaningful
  // number back. Best-effort — a DBSIZE failure must not block the flush.
  let keysDeleted = 0;
  try {
    keysDeleted = await redis.dbsize();
  } catch (err) {
    logger.warn({ err }, 'Cache: DBSIZE failed before FLUSHALL, count unavailable');
  }

  await redis.flushall();
  const postgres = await invalidateCacheTables();

  return { redis: { keysDeleted }, postgres };
}

// ---------------------------------------------------------------------------
// Translation cache
//
// Translations are cached separately from native transcripts so that
// `?language=fr` (native captions) and `?translate_to=fr` (translated from
// some other source language) can never alias each other. Key includes the
// source language because translating fr→en and bn→en produces different
// output for the same video.
// ---------------------------------------------------------------------------

export interface CachedTranslation {
  videoId: string;
  sourceLanguage: string;
  targetLanguage: string;
  transcript: string;
  segments: Segment[];
  /** Which engine produced this row: 'openai' | 'google'. */
  translator?: string;
  cachedAt: string;
}

/**
 * Two-tier read for a cached translation. Same pattern as `getCached`:
 * Redis first, then Postgres, warming Redis on a cold-tier hit.
 */
export async function getCachedTranslation(
  videoId: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<CachedTranslation | null> {
  const k = translationKey(videoId, sourceLanguage, targetLanguage);
  try {
    const fromRedis = await redis.get(k);
    if (fromRedis) {
      try {
        return JSON.parse(fromRedis) as CachedTranslation;
      } catch (err) {
        logger.warn(
          { err, videoId, sourceLanguage, targetLanguage },
          'Translation cache: corrupted Redis payload, ignoring',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Translation cache: Redis lookup failed, trying Postgres');
  }

  type Row = {
    video_id: string;
    source_language: string;
    target_language: string;
    translator: string | null;
    transcript_text: string;
    segments: Segment[];
    first_cached_at: Date;
  };

  const { rows } = await pool.query<Row>(
    `SELECT video_id, source_language, target_language, translator,
            transcript_text, segments, first_cached_at
     FROM translated_transcripts
     WHERE video_id = $1 AND source_language = $2 AND target_language = $3
       AND expires_at > NOW()`,
    [videoId, sourceLanguage, targetLanguage],
  );

  if (!rows.length) return null;

  const row = rows[0];
  const cached: CachedTranslation = {
    videoId: row.video_id,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    translator: row.translator ?? undefined,
    transcript: row.transcript_text,
    segments: row.segments,
    cachedAt: row.first_cached_at.toISOString(),
  };

  // Best-effort: bump stats + warm Redis.
  void pool
    .query(
      `UPDATE translated_transcripts
       SET last_accessed_at = NOW(), access_count = access_count + 1
       WHERE video_id = $1 AND source_language = $2 AND target_language = $3`,
      [videoId, sourceLanguage, targetLanguage],
    )
    .catch(() => {});
  void redis.setex(k, TTL_SECONDS, JSON.stringify(cached)).catch(() => {});

  return cached;
}

/**
 * Write-through translation cache. Writes Redis + Postgres; failures are
 * logged but do not fail the request — the user already has their result.
 */
export async function setCachedTranslation(
  payload: CachedTranslation,
): Promise<void> {
  const k = translationKey(payload.videoId, payload.sourceLanguage, payload.targetLanguage);

  const writes: Array<Promise<unknown>> = [
    redis.setex(k, TTL_SECONDS, JSON.stringify(payload)),
    pool.query(
      `INSERT INTO translated_transcripts
        (video_id, source_language, target_language, translator,
         transcript_text, segments, character_count, segment_count, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '30 days')
       ON CONFLICT (video_id, source_language, target_language) DO UPDATE
         SET translator = EXCLUDED.translator,
             transcript_text = EXCLUDED.transcript_text,
             segments = EXCLUDED.segments,
             character_count = EXCLUDED.character_count,
             segment_count = EXCLUDED.segment_count,
             last_accessed_at = NOW(),
             access_count = translated_transcripts.access_count + 1,
             expires_at = NOW() + INTERVAL '30 days'`,
      [
        payload.videoId,
        payload.sourceLanguage,
        payload.targetLanguage,
        payload.translator ?? null,
        payload.transcript,
        JSON.stringify(payload.segments),
        payload.transcript.length,
        payload.segments.length,
      ],
    ),
  ];

  const results = await Promise.allSettled(writes);
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn(
        { err: r.reason, videoId: payload.videoId },
        'Translation cache: write failed (non-fatal)',
      );
    }
  }
}
