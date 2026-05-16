# Cache flush preserves video metadata — design

**Date:** 2026-05-16
**Status:** Approved (design)

## Problem

The `POST /flush-cache` endpoint (and the per-video clear) wipes the entire
`cached_transcripts` table with `TRUNCATE` / `DELETE`. That table mixes two
unrelated concerns in one row:

- **Transcript content** — `transcript_text`, `segments`, `character_count`,
  `segment_count`.
- **Video metadata** — `title`, `channel`, `duration_seconds`.

`GET /me/transcripts` reads title/channel/duration from `cached_transcripts`
via a `LEFT JOIN LATERAL`. After a flush the table is empty, so every video in
a user's history renders as "Untitled" with no channel or duration.

A related bug compounds it: `fetchYouTubeMetadata` swallows oEmbed failures and
returns the literal strings `'Untitled'` / `'Unknown'`. `setCached` then
persists those placeholders, and `ON CONFLICT DO UPDATE` overwrites any
previously-good title. So even without a flush, one failed oEmbed call poisons
a video's title for the 30-day cache TTL.

## Goal

A cache flush should clear **only transcript content**. Video metadata
(`title`, `channel`, `duration_seconds`) must survive every flush so the user's
history keeps showing video id, title, and channel. Applies to all three
clear paths: global `flushAllCache()`, global `clearCache()`, and per-video
`clearCache(videoId)`.

A failed metadata fetch must never overwrite good stored metadata.

## Approach

Chosen: **Approach A — invalidate transcript content in place.** Keep the
`cached_transcripts` rows; clear only the transcript columns. No schema
change, no migration, no production backfill.

Rejected alternatives:

- **Approach B** — move metadata to a dedicated durable `video_metadata`
  table. Architecturally cleaner (metadata genuinely is not "cache"), but
  needs a migration, backfill, and changes to the write path, the
  `/me/transcripts` join, and the flush. Extra surface area not justified
  when Approach A produces identical user-facing behavior.
- **Approach C** — store title/channel on `api_requests`. Rejected:
  `api_requests` is a per-request log; duplicating metadata onto every log
  row is wasteful and semantically wrong.

Safe because there is **no purge job** for expired rows — `expires_at` is only
read-filtered (`expires_at > NOW()`), never used to delete. Setting
`expires_at = NOW()` invalidates the transcript for reads without risking the
preserved row.

## Components

### Component 1 — Cache flush preserves metadata (`cacheService.ts`)

Replace the destructive operations on `cached_transcripts` with a
metadata-preserving invalidation:

```sql
UPDATE cached_transcripts
SET transcript_text = '',
    segments        = '[]'::jsonb,
    character_count = 0,
    segment_count   = 0,
    expires_at      = NOW()
[WHERE video_id = $1]   -- WHERE clause only for the per-video clear
```

- `title`, `channel`, `duration_seconds` are never touched → survive flushes.
- `expires_at = NOW()` makes `getCached` cache-miss → next request re-fetches.
- Blanking `transcript_text` / `segments` frees the cached content.
  `transcript_text` is `NOT NULL` (use `''`); `segments` is `NOT NULL` JSONB
  (use `'[]'::jsonb`).
- `translated_transcripts` holds no metadata and is still fully removed:
  `TRUNCATE` for the global flush, `DELETE WHERE video_id` for the per-video
  clear.
- Redis `transcript:*` / `translation:*` clearing is unchanged.
  `flushAllCache()` keeps using `redis.flushall()`.

`truncateCacheTables()` is replaced by an `invalidateCacheTables()` helper used
by both `flushAllCache()` and the global `clearCache()`. The per-video
`clearCache(videoId)` gets the same `UPDATE ... WHERE video_id` plus a
`DELETE FROM translated_transcripts WHERE video_id`.

The result count `postgres.cached_transcripts` now means "rows whose transcript
was cleared" (the `UPDATE` row count) instead of "rows deleted". The
`ClearCacheResult` / `FlushAllResult` shapes are unchanged, so the
`/flush-cache` response shape is unchanged.

### Component 2 — oEmbed no longer poisons titles (`youtubeService.ts`)

- `YouTubeMetadata.title` and `.channel` become `string | null`.
- `fetchYouTubeMetadata` returns `null` for title/channel on failure or an
  unparseable response — instead of `'Untitled'` / `'Unknown'`. `null` is an
  honest "could not determine" signal; the placeholder strings looked like
  real data.

### Component 3 — Writes never clobber good metadata (`cacheService.ts`, `transcriptService.ts`)

- `CachedTranscript.title` and `.channel` become `string | null` (the DB
  columns are already nullable). Downstream consumers of `CachedTranscript`
  that pass `.title` into API responses accept `string | null`;
  `/me/transcripts` already handles a null title.
- `setCached`'s `ON CONFLICT DO UPDATE` uses `COALESCE` so a missing value
  cannot overwrite a stored good one:

  ```sql
  SET title            = COALESCE(EXCLUDED.title,            cached_transcripts.title),
      channel          = COALESCE(EXCLUDED.channel,          cached_transcripts.channel),
      duration_seconds = COALESCE(EXCLUDED.duration_seconds, cached_transcripts.duration_seconds),
      source           = EXCLUDED.source,
      transcript_text  = EXCLUDED.transcript_text,
      segments         = EXCLUDED.segments,
      character_count  = EXCLUDED.character_count,
      segment_count    = EXCLUDED.segment_count,
      last_accessed_at = NOW(),
      access_count     = cached_transcripts.access_count + 1,
      expires_at       = NOW() + INTERVAL '30 days'
  ```

- `getCached` keeps its existing `row.title ?? 'Untitled'` /
  `row.channel ?? 'Unknown'` read fallback, so a never-resolved title still
  displays gracefully.

Net effect: after a flush the row keeps its title. A re-fetch with a failed
oEmbed writes `null` → `COALESCE` keeps the old title. A re-fetch with a
successful oEmbed updates it. No "Untitled" poisoning either way.

## Out of scope (YAGNI)

- No new table or migration (that was Approach B).
- No oEmbed retry or concurrency cap — the `COALESCE` fix already stops
  poisoning. Can be added later if the post-flush oEmbed burst proves
  unreliable in practice.

## Testing

- `cacheService`: after each of the three flush paths, assert
  `cached_transcripts` rows still exist with `title` / `channel` /
  `duration_seconds` intact, `transcript_text` empty, `segments` `[]`,
  `expires_at` in the past; `translated_transcripts` empty (global) or rows
  for the target video gone (per-video).
- `getCached` returns `null` (cache-miss) for a flushed video.
- `fetchYouTubeMetadata` returns `null` title/channel when oEmbed fails.
- `setCached`: re-writing a row with `null` title via `ON CONFLICT` leaves the
  existing stored title intact; a non-null title overwrites it.

## Affected files

- `backend/src/services/cacheService.ts` — flush logic, `setCached` COALESCE,
  `CachedTranscript` type.
- `backend/src/services/youtubeService.ts` — `fetchYouTubeMetadata`,
  `YouTubeMetadata` type.
- `backend/src/services/transcriptService.ts` — consumes `metadata.title` /
  `metadata.channel`; adjust for `string | null`.
