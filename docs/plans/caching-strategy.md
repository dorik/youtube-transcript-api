# Caching Strategy

## What this is

Most YouTube videos that any one customer cares about have already been transcribed by some other customer — and even within a single customer's workflow, the same video gets requested multiple times as their pipeline retries, reprocesses, or reloads the dashboard. Caching is the single biggest lever on cost, latency, and reliability for this product, and it deserves a dedicated design rather than being an afterthought sprinkled around the fetch path.

The cache is two-tier: a hot Redis layer for sub-millisecond reads, and a durable Postgres layer that survives Redis evictions and restarts. Reads check Redis first, fall back to Postgres on a miss, and only hit YouTube (or Whisper) as a last resort. Writes go the other direction — Postgres first as the canonical record, then Redis as a warm copy. A cached response costs the customer zero credits, which is both fair (we did no real work) and a strong incentive for them to design idempotent pipelines.

The trickiest part of the design is the language dimension. A customer can ask for `?lang=auto` and the system might return Bengali, English, or whatever the video happens to have. We cannot key the cache on `auto` alone because two different videos with `auto` would produce different real languages, and we cannot only key on the real language because then a follow-up `auto` request wouldn't find the existing row. The solution — described in detail below under "auto-fallback" — is what makes the production deployment work even though Render's outbound IPs are blocked by YouTube; we populate Postgres locally, then serve from Postgres in production.

A scheduled cleanup job for stale Postgres rows (say, anything older than a year that hasn't been read in six months) is intentionally out of scope for the MVP. Storage is cheap, transcripts don't really go bad, and we'd rather defer the eviction policy until we have real usage data telling us what to evict.

## Backend

### Schema

The cache lives in two places.

In Postgres, create a `cached_transcripts` table with one row per `(video_id, language)` pair. Columns:
- `video_id` — the 11-character YouTube video ID, the same one extracted from the input URL.
- `language` — the **actual** language code of the stored transcript (`en`, `bn`, `es`, etc.). Never `auto`. This is the single most important rule of the schema.
- `source` — one of `native`, `whisper`. Tells us where the segments originally came from so analytics can distinguish.
- `segments` — the canonical segment array stored as JSONB.
- `title`, `duration_seconds`, `channel` — denormalized YouTube metadata so we don't have to refetch on a cache hit.
- `created_at`, `updated_at` — timestamps.
- A unique index on `(video_id, language)`. A separate non-unique index on `video_id` alone so the auto-fallback lookup is fast.

In Redis, no schema, just a key convention. Keys are shaped `transcript:<videoId>:<language>` where `language` here is the **requested** language (which can be `auto`, or `en`, or any specific code). The value is the serialized canonical payload (segment array plus the small set of metadata fields). TTL is 30 days, refreshed on every read so popular videos stay warm forever.

### Endpoints

No new public endpoints — caching is a transparent layer behind `GET /v1/transcript`. There is one internal admin endpoint, `DELETE /admin/cache/:videoId`, gated behind an admin API key, which purges both the Redis entries and the Postgres rows for a given video. This exists for the rare case of a corrupted transcript or a takedown request.

The public endpoint's response includes a `source` field in the JSON payload (`cache`, `native`, or `whisper`) and an `X-Cache: HIT|MISS` response header so customers can tell whether they were charged.

### Logic

**The read path** is checked in this strict order on every request:

1. **Redis lookup at `transcript:<videoId>:<requestedLang>`.** If present, deserialize and return immediately with `source: cache`, `X-Cache: HIT`, and zero credit deduction. Refresh the TTL back to 30 days on the way out.
2. **Postgres lookup with `(video_id, language) = (videoId, requestedLang)`.** If a row exists, serve it. This is still a cache hit — `source: cache`, `X-Cache: HIT`, zero credits — but additionally warm Redis on the way out so the next call is a tier-1 hit.
3. **Auto-fallback Postgres lookup**, only if `requestedLang === 'auto'` and step 2 missed. Look for *any* row where `video_id = videoId`, ordered by `updated_at` desc, take the first. If found, serve it as a cache hit. Also warm Redis under both keys: the canonical `transcript:<videoId>:<actualLang>` *and* the alias `transcript:<videoId>:auto` so future `auto` requests hit Redis directly. This step is the load-bearing trick that lets production work despite the Render IP block — local development populates Postgres with real language codes, and production serves those rows for any `auto` request without ever needing to call YouTube.
4. **Fresh fetch.** Try the YouTube native-caption fetcher with the requested language. If that fails or returns empty, fall back to Whisper (real or stubbed depending on `STUB_WHISPER`). Either way, the result has a definite actual language code.
5. **Credit deduction.** Charge the customer for the fresh work — 1 credit for native, ceil(minutes) for Whisper, plus translation surcharge if applicable.
6. **Cache write.** Only after the deduction succeeds, write the result.

**The write path** is also strict-ordered to keep the canonical Postgres row consistent:

1. **Postgres upsert first.** Insert (or update on conflict) into `cached_transcripts` with `(video_id, language=actualLang, source, segments, ...)`. The language column gets the actual returned language, never `auto`. This is the canonical record.
2. **Redis warm-write for the canonical key.** Set `transcript:<videoId>:<actualLang>` with 30-day TTL.
3. **Redis alias write, if applicable.** If the customer's requested language differs from the actual language (typical example: requested `auto`, got `bn`), also set `transcript:<videoId>:<requestedLang>` to the same payload with 30-day TTL. This is the alias trick — it means an identical follow-up request from the same caller is a Redis hit even though only the actual-language row exists in Postgres.

**Why deduction before cache write.** If we wrote the cache first and then deduction failed (insufficient credits, race condition, transient DB error), we would have served a 402 to the customer while still populating the cache for free, effectively letting an unfunded customer poison-fill our cache. By making deduction a hard prerequisite, the cache only ever contains transcripts that someone successfully paid for.

**Why the alias instead of a second canonical row.** If we wrote two Postgres rows — one for `bn` and one for `auto` — we'd duplicate storage and have to keep them in sync if a transcript ever got re-fetched. The Redis alias is ephemeral (30-day TTL, evictable), costs nothing, and naturally rebuilds from the auto-fallback lookup whenever it expires.

**Edge cases:**
- Two concurrent requests for the same uncached video — both will miss, both will fetch, both will try to upsert. The Postgres unique index makes the second upsert a no-op (ON CONFLICT DO UPDATE returning the existing row), so only one transcript is ever stored, but both customers get charged. This is acceptable; deduplicating concurrent fetches would require a distributed lock that isn't worth the complexity at MVP scale.
- A transcript that fails to fetch and fails to Whisper — return a 5xx with no cache write and no credit deduction. We do not negatively cache failures.
- A transcript that returns successfully but with an empty segment array — this is rare but real (silent video, or a livestream with no captions). Cache it anyway under the empty-segments shape; the customer paid for the lookup work and a follow-up call should also be free.
- A customer requests a specific language we don't have — auto-fallback does *not* trigger here (it only triggers on `auto`), so we go fresh-fetch and try to get that specific language. If YouTube returns a different language than asked, the canonical row is written under what was actually returned, and the Redis alias under what was requested.

## Frontend

The dashboard surfaces cache state in two places. The transcript viewer page shows a small "Cached" badge next to videos that came from the cache, and the recent-requests table on the usage page (see usage analytics) shows `source: cache` rows separately from `native` and `whisper`. There is no cache-clearing button for end users; the admin purge endpoint is for internal use only.

## Dependencies

None for the read/write logic itself. The "cached responses cost 0 credits" rule depends on the credits system existing (see credits-and-rate-limiting), but the cache machinery can be built first and simply pass `cost = 0` to whatever deduction routine eventually exists.

## Verification

Hit the same video twice in a row. The first response has `X-Cache: MISS`, `source: native` (or `whisper`), and the customer's credit balance drops by the appropriate amount. The second response has `X-Cache: HIT`, `source: cache`, and the credit balance is unchanged.

Fetch a video locally with `lang=bn` so a row exists in Postgres under `(videoId, 'bn')`. Then deploy to staging where YouTube fetches are blocked, and request the same video with `lang=auto`. The auto-fallback lookup should serve the Bengali row as a cache hit, and a follow-up `lang=auto` request should be a Redis hit (verifiable by the response header).

Flush Redis (`redis-cli FLUSHALL` in dev) and request a previously-cached video. The response should still be a hit — served from Postgres — and Redis should be warm again afterward.

Manually corrupt a `cached_transcripts` row (set `segments = '[]'`). The next request should serve the empty-segments payload as a cache hit, proving the cache layer doesn't refetch on its own. Then call `DELETE /admin/cache/:videoId` and the next request should miss and refetch fresh.
