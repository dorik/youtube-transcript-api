# Cache Flush Preserves Metadata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cache flushing clear only transcript content while preserving video metadata (title, channel, duration), and stop failed oEmbed calls from poisoning titles with `'Untitled'`.

**Architecture:** Approach A from the design spec — `cached_transcripts` rows are kept; flush `UPDATE`s them to blank the transcript columns and set `expires_at = NOW()` instead of `TRUNCATE`/`DELETE`. `fetchYouTubeMetadata` returns `null` (not placeholder strings) on failure, and `setCached` uses `COALESCE` so a `null` never overwrites stored metadata.

**Tech Stack:** TypeScript, Node, Express, Postgres (`pg`), Redis (`ioredis`), Vitest.

> **Committing:** Do NOT run `git commit`. The user reviews all changes and commits at the end. Each task ends with a verification step instead of a commit.

**Spec:** `docs/superpowers/specs/2026-05-16-cache-flush-preserve-metadata-design.md`

---

## File Structure

- `backend/vitest.config.ts` — add `test.env` so service modules (which import `config/env`, which hard-exits on missing vars) can be imported under test.
- `backend/src/services/youtubeService.ts` — `YouTubeMetadata` type + `fetchYouTubeMetadata`.
- `backend/src/services/youtubeService.test.ts` — **new** — tests for `fetchYouTubeMetadata`.
- `backend/src/services/cacheService.ts` — `CachedTranscript` type, `setCached` COALESCE, flush logic.
- `backend/src/services/cacheService.test.ts` — **new** — tests for flush + `setCached`.
- `backend/src/services/transcriptService.ts` — `formatResponse` coalesces null metadata for the API response.

All commands below run from `backend/`.

---

## Task 1: oEmbed metadata returns `null` on failure

**Files:**
- Modify: `backend/vitest.config.ts`
- Modify: `backend/src/services/youtubeService.ts:37-42` (`YouTubeMetadata` interface), `backend/src/services/youtubeService.ts:513-546` (`fetchYouTubeMetadata`)
- Test: `backend/src/services/youtubeService.test.ts` (new)

- [ ] **Step 1: Add `test.env` to vitest config**

`config/env.ts` calls `process.exit(1)` when `DATABASE_URL` / `REDIS_URL` / `JWT_SECRET` are missing. Any test importing a service module triggers this, so provide dummy values.

In `backend/vitest.config.ts`, add an `env` block inside `test`:

```ts
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-jwt-secret-0123456789',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/services/formatters.ts', 'src/utils/**/*.ts'],
    },
  },
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/services/youtubeService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// fetchYouTubeMetadata calls axios.get for the oEmbed endpoint. Mock the
// default export so no real network call is made.
const getMock = vi.fn();
vi.mock('axios', () => ({
  default: { get: (...args: unknown[]) => getMock(...args) },
}));

import { fetchYouTubeMetadata } from './youtubeService';

describe('fetchYouTubeMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null title/channel/thumbnail when the oEmbed call fails', async () => {
    getMock.mockRejectedValue(new Error('HTTP 429'));
    const md = await fetchYouTubeMetadata('vid123');
    expect(md).toEqual({
      videoId: 'vid123',
      title: null,
      channel: null,
      thumbnailUrl: null,
    });
  });

  it('returns null for individual fields missing from the oEmbed response', async () => {
    getMock.mockResolvedValue({ data: { author_name: 'Some Channel' } });
    const md = await fetchYouTubeMetadata('vid123');
    expect(md.title).toBeNull();
    expect(md.channel).toBe('Some Channel');
    expect(md.thumbnailUrl).toBeNull();
  });

  it('returns the real values when the oEmbed call succeeds', async () => {
    getMock.mockResolvedValue({
      data: {
        title: 'Real Title',
        author_name: 'Real Channel',
        thumbnail_url: 'https://img/t.jpg',
      },
    });
    const md = await fetchYouTubeMetadata('vid123');
    expect(md).toEqual({
      videoId: 'vid123',
      title: 'Real Title',
      channel: 'Real Channel',
      thumbnailUrl: 'https://img/t.jpg',
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/services/youtubeService.test.ts`
Expected: FAIL — the first two tests fail because the current code returns `'Untitled'` / `'Unknown'` instead of `null`.

- [ ] **Step 4: Change the `YouTubeMetadata` type**

In `backend/src/services/youtubeService.ts`, change the interface (currently lines 37-42):

```ts
export interface YouTubeMetadata {
	videoId: string;
	title: string | null;
	channel: string | null;
	thumbnailUrl: string | null;
}
```

- [ ] **Step 5: Change `fetchYouTubeMetadata` to return `null` instead of placeholders**

In `backend/src/services/youtubeService.ts`, replace the body of `fetchYouTubeMetadata` (currently lines 513-546). Update the doc comment's last sentence and both `return` statements:

```ts
export async function fetchYouTubeMetadata(
	videoId: string,
): Promise<YouTubeMetadata> {
	try {
		const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
		const {data} = await axios.get(url, {
			timeout: 8_000,
			...proxyAxiosOptions(),
		});
		return {
			videoId,
			// `null` (not 'Untitled') when oEmbed omits a field — a null is an
			// honest "unknown" the caller / SQL COALESCE can react to, whereas a
			// placeholder string would be persisted as if it were real data.
			title: typeof data.title === 'string' ? data.title : null,
			channel:
				typeof data.author_name === 'string' ? data.author_name : null,
			thumbnailUrl:
				typeof data.thumbnail_url === 'string'
					? data.thumbnail_url
					: null,
		};
	} catch (err) {
		logger.warn(
			{err, videoId},
			'oEmbed metadata fetch failed; returning null metadata',
		);
		return {
			videoId,
			title: null,
			channel: null,
			thumbnailUrl: null,
		};
	}
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/services/youtubeService.test.ts`
Expected: PASS — all 3 tests pass.

- [ ] **Step 7: Verify no type regressions in youtubeService**

Run: `npx tsc --noEmit`
Expected: There may be errors in `cacheService.ts` / `transcriptService.ts` about `string | null` not assignable to `string` — those are fixed in Tasks 2 and 4. There must be **no new errors inside `youtubeService.ts` itself**. If `tsc` reports a `youtubeService.ts` error, fix it before continuing.

---

## Task 2: `setCached` never overwrites good metadata (COALESCE)

**Files:**
- Modify: `backend/src/services/cacheService.ts:6-16` (`CachedTranscript` interface), `backend/src/services/cacheService.ts:154-186` (`setCached` INSERT)
- Test: `backend/src/services/cacheService.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/cacheService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// cacheService talks to Postgres (pool) and Redis. Mock both modules so the
// tests assert the SQL/Redis operations issued, with no real connections.
const queryMock = vi.fn();

vi.mock('../db/pool', () => ({
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
  },
  // invalidateCacheTables() runs inside withTransaction; the fake just calls
  // the callback with a client whose query() is the same recording mock.
  withTransaction: async (fn: (client: unknown) => unknown) =>
    fn({ query: (...args: unknown[]) => queryMock(...args) }),
}));

const redisMock = {
  get: vi.fn(),
  setex: vi.fn(),
  scan: vi.fn(),
  del: vi.fn(),
  flushall: vi.fn(),
  dbsize: vi.fn(),
};
vi.mock('../cache/redis', () => ({ redis: redisMock }));

import { setCached } from './cacheService';

const sqlsFrom = (mock: typeof queryMock): string[] =>
  mock.mock.calls.map((c) => String(c[0]));

describe('setCached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rowCount: 1, rows: [] });
    redisMock.setex.mockResolvedValue('OK');
  });

  it('uses COALESCE so a null title/channel cannot overwrite stored metadata', async () => {
    await setCached({
      videoId: 'v1',
      language: 'en',
      title: null,
      channel: null,
      durationSeconds: 12,
      source: 'native_captions',
      transcript: 'hello',
      segments: [{ start: 0, duration: 1, text: 'hello' }],
      cachedAt: new Date().toISOString(),
    });
    const insertSql = sqlsFrom(queryMock).find((s) =>
      /INSERT INTO cached_transcripts/i.test(s),
    );
    expect(insertSql).toBeDefined();
    expect(insertSql!).toMatch(/title\s*=\s*COALESCE\(EXCLUDED\.title/i);
    expect(insertSql!).toMatch(/channel\s*=\s*COALESCE\(EXCLUDED\.channel/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/cacheService.test.ts`
Expected: FAIL — current `setCached` uses `title = EXCLUDED.title` with no COALESCE.

- [ ] **Step 3: Make `CachedTranscript` title/channel nullable**

In `backend/src/services/cacheService.ts`, change the interface (currently lines 6-16):

```ts
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
```

- [ ] **Step 4: Add COALESCE to the `setCached` upsert**

In `backend/src/services/cacheService.ts`, in `setCached`, replace the `ON CONFLICT (video_id, language) DO UPDATE` SET list (currently lines 160-171) so the metadata columns keep the existing value when the incoming one is `NULL`:

```ts
        `INSERT INTO cached_transcripts
          (video_id, language, title, channel, duration_seconds, source,
           transcript_text, segments, character_count, segment_count, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + INTERVAL '30 days')
         ON CONFLICT (video_id, language) DO UPDATE
           SET title = COALESCE(EXCLUDED.title, cached_transcripts.title),
               channel = COALESCE(EXCLUDED.channel, cached_transcripts.channel),
               duration_seconds = COALESCE(EXCLUDED.duration_seconds, cached_transcripts.duration_seconds),
               source = EXCLUDED.source,
               transcript_text = EXCLUDED.transcript_text,
               segments = EXCLUDED.segments,
               character_count = EXCLUDED.character_count,
               segment_count = EXCLUDED.segment_count,
               last_accessed_at = NOW(),
               access_count = cached_transcripts.access_count + 1,
               expires_at = NOW() + INTERVAL '30 days'`,
```

(Only the first three SET lines change; the rest are unchanged and shown for context.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/services/cacheService.test.ts`
Expected: PASS.

---

## Task 3: Cache flush preserves metadata

**Files:**
- Modify: `backend/src/services/cacheService.ts` — `truncateCacheTables` (lines 234-271), `clearCache` (lines 273-307), `flushAllCache` (lines 315-342), and the import on line 2.
- Test: `backend/src/services/cacheService.test.ts` (extend the file from Task 2)

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/services/cacheService.test.ts`:

```ts
import { clearCache, flushAllCache } from './cacheService';

describe('cache flush preserves metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.flushall.mockResolvedValue('OK');
    redisMock.dbsize.mockResolvedValue(0);
    redisMock.scan.mockResolvedValue(['0', []]); // empty keyspace
    queryMock.mockImplementation((sql: string) => {
      if (/SELECT COUNT/i.test(sql)) return Promise.resolve({ rows: [{ count: '0' }] });
      if (/UPDATE cached_transcripts/i.test(sql)) return Promise.resolve({ rowCount: 3, rows: [] });
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
  });

  it('flushAllCache UPDATEs cached_transcripts instead of dropping it', async () => {
    await flushAllCache();
    const sqls = sqlsFrom(queryMock);
    expect(sqls.some((s) => /UPDATE cached_transcripts/i.test(s))).toBe(true);
    expect(sqls.some((s) => /TRUNCATE\s+cached_transcripts/i.test(s))).toBe(false);
    expect(sqls.some((s) => /DELETE FROM cached_transcripts/i.test(s))).toBe(false);
  });

  it('the flush UPDATE never mutates the metadata columns', async () => {
    await flushAllCache();
    const updateSql = sqlsFrom(queryMock).find((s) =>
      /UPDATE cached_transcripts/i.test(s),
    )!;
    expect(updateSql).not.toMatch(/\btitle\b/);
    expect(updateSql).not.toMatch(/\bchannel\b/);
    expect(updateSql).not.toMatch(/duration_seconds/);
  });

  it('global clearCache() also UPDATEs rather than truncates cached_transcripts', async () => {
    await clearCache();
    const sqls = sqlsFrom(queryMock);
    expect(sqls.some((s) => /UPDATE cached_transcripts/i.test(s))).toBe(true);
    expect(sqls.some((s) => /TRUNCATE\s+cached_transcripts/i.test(s))).toBe(false);
  });

  it('per-video clearCache(videoId) invalidates only the target video and keeps metadata', async () => {
    await clearCache('abc12345678');
    const updateCall = queryMock.mock.calls.find((c) =>
      /UPDATE cached_transcripts/i.test(String(c[0])),
    );
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toMatch(/WHERE video_id = \$1/i);
    expect(updateCall![1]).toEqual(['abc12345678']);
    expect(String(updateCall![0])).not.toMatch(/\btitle\b/);
    // cached_transcripts is never DELETEd; only translated_transcripts is.
    const sqls = sqlsFrom(queryMock);
    expect(sqls.some((s) => /DELETE FROM cached_transcripts/i.test(s))).toBe(false);
    expect(sqls.some((s) => /DELETE FROM translated_transcripts/i.test(s))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/cacheService.test.ts`
Expected: FAIL — current code TRUNCATEs / DELETEs `cached_transcripts`.

- [ ] **Step 3: Import `withTransaction`**

In `backend/src/services/cacheService.ts`, change the import on line 2 from:

```ts
import { pool } from '../db/pool';
```

to:

```ts
import { pool, withTransaction } from '../db/pool';
```

- [ ] **Step 4: Add the shared SET clause and replace `truncateCacheTables`**

In `backend/src/services/cacheService.ts`, replace `truncateCacheTables` (currently lines 234-271, including its doc comment) with the shared constant and a metadata-preserving helper:

```ts
/**
 * Shared SET clause: clears the transcript CONTENT columns and expires the
 * row, while deliberately NOT touching `title` / `channel` /
 * `duration_seconds`. Those metadata columns must outlive a flush so
 * `/me/transcripts` can still render title/channel/duration.
 *
 * `expires_at = NOW()` makes the row fail `getCached`'s `expires_at > NOW()`
 * filter, so the next request cache-misses and re-fetches the transcript.
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
```

- [ ] **Step 5: Update `clearCache` to preserve metadata**

In `backend/src/services/cacheService.ts`, replace the body of `clearCache` (currently lines 273-307). The per-video branch UPDATEs instead of DELETEs `cached_transcripts`; the global branch calls `invalidateCacheTables()`:

```ts
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
```

- [ ] **Step 6: Update `flushAllCache` to preserve metadata**

In `backend/src/services/cacheService.ts`, in `flushAllCache` (currently lines 315-342), replace the call to `truncateCacheTables()` with `invalidateCacheTables()`, and update the doc comment's last paragraph:

```ts
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
```

- [ ] **Step 7: Update the cache-invalidation section comment**

In `backend/src/services/cacheService.ts`, the block comment above `ClearCacheResult` (currently lines 196-206) says `clearCache` "wipes both tiers". Update the first paragraph to reflect the new behavior:

```ts
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
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/services/cacheService.test.ts`
Expected: PASS — all `setCached` and flush tests pass.

---

## Task 4: Fix consumers + full verification

**Files:**
- Modify: `backend/src/services/transcriptService.ts` — `formatResponse` (around lines 700-712)

- [ ] **Step 1: Run the typechecker to find remaining consumer breaks**

Run: `npx tsc --noEmit`
Expected: An error in `transcriptService.ts` `formatResponse` — `payload.title` (now `string | null`) is not assignable to `TranscriptResponse.title` (`string`). This is fixed in Step 2. Note any *other* files reported.

- [ ] **Step 2: Coalesce null metadata at the API response boundary**

`TranscriptResponse.title` / `.channel` stay `string` — the API response should always carry a display value. The cache stores honest `null`; the response coalesces it. In `backend/src/services/transcriptService.ts`, in `formatResponse`, change the `base` object's title/channel lines:

```ts
		title: payload.title ?? 'Untitled',
		channel: payload.channel ?? 'Unknown',
```

(`payload.duration` / `payload.durationSeconds` is unchanged — `durationSeconds` is a non-nullable `number`.)

- [ ] **Step 3: Resolve any other typecheck breaks**

Run: `npx tsc --noEmit`
Expected: PASS with no errors.

If `tsc` still reports errors in other files, they will be of the form "`string | null` not assignable to `string`" where a `CachedTranscript` / `YouTubeMetadata` title or channel reaches a `string`-typed field. Fix each by coalescing at that boundary (`value ?? 'Untitled'` for a title, `value ?? 'Unknown'` for a channel) — never by casting away the `null`. Do not change a stored/cached field to a coalesced string; only coalesce values headed into a response or display type.

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all test files green, including the two new ones (`youtubeService.test.ts`, `cacheService.test.ts`) and the pre-existing suites.

- [ ] **Step 5: Final verification summary**

Confirm all of the following before reporting the plan complete:
- `npx tsc --noEmit` — no errors.
- `npx vitest run` — all tests pass.
- `cacheService.ts` contains no `TRUNCATE cached_transcripts` and no `DELETE FROM cached_transcripts`.

Run: `grep -nE "TRUNCATE cached_transcripts|DELETE FROM cached_transcripts" src/services/cacheService.ts`
Expected: no output (exit code 1).

Do not commit — hand the working tree to the user for review and commit.

---

## Self-Review

**Spec coverage:**
- Component 1 (flush preserves metadata, all 3 paths) → Task 3 (`invalidateCacheTables`, `clearCache` per-video + global, `flushAllCache`).
- Component 2 (oEmbed returns `null`) → Task 1.
- Component 3 (`COALESCE`, nullable `CachedTranscript`) → Task 2; consumer fix → Task 4.
- Testing section of spec → tests in Tasks 1–3; full-suite gate in Task 4.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. Task 4 Step 3 gives an explicit rule (coalesce at display boundary) rather than "handle appropriately".

**Type consistency:** `YouTubeMetadata.title/channel: string | null` (Task 1) and `CachedTranscript.title/channel: string | null` (Task 2) are consistent. `fetchYouTubeMetadata` → `setCached` payload → `formatResponse` boundary all account for `null`. `invalidateCacheTables` and `CLEAR_TRANSCRIPT_SET` names are used consistently in Task 3. `TranscriptResponse.title` stays `string`, satisfied by the coalesce in Task 4 Step 2.
