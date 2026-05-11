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

/**
 * Known placeholder transcripts we don't want to serve out of the cache.
 *
 * Pre-fix code persisted the Whisper stub ("Upgrade your plan…") into the
 * cache as if it were a real transcript, which then got translated +
 * re-cached for every target language. We treat anything starting with
 * one of these markers as a cache miss and proactively evict the row, so
 * legacy poisoned data self-heals on the next read.
 *
 * Add new prefixes here if other canned/error placeholders ever leak into
 * the cache layer (e.g. a deprecated rate-limit message). Use the first
 * 50–80 chars — long enough to be unique, short enough to survive minor
 * copy edits to the trailing portion of the string.
 */
const PLACEHOLDER_MARKERS = [
  'AI transcription (Whisper) is only available on paid plans.',
];

export function isPlaceholderTranscript(text: string): boolean {
  if (!text) return false;
  return PLACEHOLDER_MARKERS.some((marker) => text.startsWith(marker));
}

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
        const parsed = JSON.parse(fromRedis) as CachedTranscript;
        // Self-heal: a legacy stub poisoned this slot. Drop it from Redis
        // and fall through to Postgres (which may or may not also be
        // polluted). Caller treats us as a miss → re-fetch fresh content.
        if (isPlaceholderTranscript(parsed.transcript)) {
          logger.info(
            { videoId, language },
            'Cache: evicting placeholder transcript from Redis',
          );
          await redis.del(key(videoId, language)).catch(() => {});
        } else {
          return parsed;
        }
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

  // Self-heal: legacy stub row from before write-side prevention landed.
  // Delete it and signal a miss so the orchestrator re-fetches fresh.
  // We use the row's own (video_id, language) for the DELETE, not the
  // request's — they can differ when the 'auto' lookup fell back to the
  // any-language path above.
  if (isPlaceholderTranscript(row.transcript_text)) {
    logger.info(
      { videoId, language: row.language, requestedLanguage: language },
      'Cache: evicting placeholder transcript from Postgres',
    );
    await pool
      .query(
        `DELETE FROM cached_transcripts WHERE video_id = $1 AND language = $2`,
        [row.video_id, row.language],
      )
      .catch((err) => {
        logger.warn(
          { err, videoId: row.video_id },
          'Cache: failed to delete placeholder row (will retry on next read)',
        );
      });
    return null;
  }

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
  /** Which engine produced this row: 'openai' | 'google' | 'stub'. */
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
 *
 * Caller is responsible for not passing stubbed translations here. We
 * don't want the `[src→tgt]` placeholder text getting cached for 30 days.
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
