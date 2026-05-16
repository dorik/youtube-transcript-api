# Async Transcript Queue — Design

- **Date:** 2026-05-16
- **Status:** Approved (pending spec review)
- **Branch:** `feat/queue`

## Problem

Transcript requests run synchronously inside the HTTP request. When a video has
no native YouTube captions, the request must download the audio (yt-dlp → MP3),
run OpenAI Whisper, and optionally translate via OpenAI/Google. That can take
30 seconds to several minutes — long enough that:

- the browser or Render's proxy drops the connection before the work finishes;
- the user's page is blocked and they cannot submit another video;
- a transient YouTube IP-block fails the whole request with no retry;
- a deploy or restart mid-request silently loses the work.

We want transcript requests to be **asynchronous**: submitting a URL enqueues
the work, returns immediately, and the user can leave the page or submit more
requests. Results appear in the transcript list as each request completes.

## Goals

- Submitting a transcript request returns immediately with a `queued` entry.
- The user can submit many requests without waiting for earlier ones.
- A single unified transcript list shows queued, processing, completed, and
  failed entries — there is no separate "jobs" list or route.
- Live status updates via Server-Sent Events.
- Transient upstream failures retry automatically; permanent failures do not.
- Worker crashes mid-request do not strand an entry in `processing` forever.

## Non-goals

- Bulk playlist/channel async processing. The existing synchronous
  `runBulkTranscripts` and the dead `jobs` / `job_videos` tables are untouched;
  a future feature may make bulk async.
- A separate Render worker service. The worker runs in-process (see Decisions).
- Backfilling pre-existing transcript history into the new list.

## Decisions

| # | Decision |
|---|----------|
| 1 | **Async everywhere.** Both `/me/transcripts` (dashboard) and `/v1/transcript` (API) enqueue and return an entry id. This is a breaking change for `/v1/transcript`; acceptable while still Phase 1 MVP. |
| 2 | **BullMQ** is the queue library, backed by the existing Render Redis. |
| 3 | **In-process worker.** The BullMQ `Worker` runs inside the existing Express service (no paid Render worker service). Concurrency is low to fit the 512 MB box. |
| 4 | **Gate at enqueue, charge on success.** Enqueue is rejected if the user cannot afford it; 1 credit is deducted only when a request completes with fresh work (cache hits remain free). Failed requests cost nothing — no refund flow. |
| 5 | **SSE** for live status updates to the dashboard. |
| 6 | **One unified list.** Queued/processing/completed/failed entries all live in the transcript list. No "jobs" concept in routes or UI. |
| 7 | Per-user pending cap: **50** queued/active requests. |
| 8 | Worker concurrency: **2** (env-configurable via `QUEUE_CONCURRENCY`). |
| 9 | Cancellation is allowed only while an entry is `queued`. |

## Architecture

### Data model

New migration `013_transcript_requests.sql`:

```
transcript_requests
  id               UUID PK DEFAULT gen_random_uuid()
  user_id          UUID NOT NULL FK → users(id) ON DELETE CASCADE
  source           VARCHAR(10)  NOT NULL          -- 'api' | 'dashboard'
  status           VARCHAR(12)  NOT NULL DEFAULT 'queued'
                                -- queued | processing | completed | failed | canceled
  request          JSONB        NOT NULL          -- { url, format, language,
                                                  --   native_only, translate_to }
  -- Metadata, populated either at enqueue (if the caller supplied it) or by
  -- the worker's first step. Lets a queued row render before transcription.
  video_id         VARCHAR(20)
  title            VARCHAR(512)
  channel          VARCHAR(255)
  duration_seconds INTEGER
  thumbnail_url    VARCHAR(500)
  -- Queue + outcome
  bullmq_job_id    VARCHAR(64)                    -- link to the BullMQ job
  attempts         INTEGER      NOT NULL DEFAULT 0
  result           JSONB                          -- full TranscriptResponse;
                                                  -- NULL until status=completed
  credits_used     INTEGER
  error_code       VARCHAR(50)
  error_message    TEXT
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  started_at       TIMESTAMPTZ
  completed_at     TIMESTAMPTZ

  INDEX (user_id, created_at DESC)
  INDEX (status)
```

De-duplication of identical requests is enforced in application code (see the
Enqueue gate, below) rather than by a DB unique constraint, because `video_id`
is `NULL` until resolved and a `canceled`/`failed` entry must not block a fresh
request for the same video.

The dead `jobs` / `job_videos` tables (migration `010`) are left in place,
unused.

### Queue and worker

- `src/queue/connection.ts` — a dedicated ioredis connection with
  `maxRetriesPerRequest: null` (required by BullMQ). The existing
  `src/cache/redis.ts` connection is unchanged and keeps `maxRetriesPerRequest: 3`.
- `src/queue/transcriptQueue.ts` — the BullMQ `Queue` named `transcript-requests`,
  plus an in-process `EventEmitter` that the SSE layer subscribes to.
- `src/queue/worker.ts` — the BullMQ `Worker`, started from `index.ts` on boot,
  `concurrency = QUEUE_CONCURRENCY` (default 2).

**Worker processor steps:**

1. Load the `transcript_requests` row; mark `status = processing`, set
   `started_at`; emit a `processing` event.
2. If metadata columns are empty, call `fetchYouTubeMetadata(videoId)` (fast —
   no audio download), write `title` / `channel` / `duration_seconds` /
   `thumbnail_url`, emit an event so the row fills in.
3. Call the existing `getTranscript()` service. All transcript logic — cache,
   captions, Whisper, translation, **and credit deduction** — is unchanged;
   only the call site moves into the worker.
4. On success: write `result`, `credits_used`, `status = completed`,
   `completed_at`; write the usual `api_requests` log row (moved here from the
   route so usage charts still capture every request); emit `completed`.
5. On failure: write `error_code` / `error_message`, `status = failed`,
   `completed_at`; write the `api_requests` log row; emit `failed`.

**Retry policy:**

- BullMQ job options: `attempts: 3`, exponential backoff (base 5 s).
- Transient failures (`UpstreamBlockedError`, network errors) are thrown
  normally so BullMQ retries them.
- Permanent failures (`NoTranscriptError`, `UpgradeRequiredError`,
  `ValidationError`, `PaymentRequiredError`) are re-thrown as BullMQ
  `UnrecoverableError` — no retry, marked `failed` immediately.

**Stalled requests:** BullMQ's built-in stalled-job detection requeues a job
whose worker died mid-process, so an entry cannot stay `processing` forever.

### Enqueue gate

`POST /me/transcripts` and `POST /v1/transcript` perform, in one transaction:

1. **Validate** the request (URL, format, language) — same Zod schema as today.
2. **Credit gate** — reject `402` if
   `balance − (count of the user's queued/processing requests) < 1`.
3. **Pending cap** — reject `429` if the user already has ≥ 50 queued/processing
   requests.
4. **De-dup** — if an identical `queued`/`processing` request exists (same user,
   resolved `video_id` when known or raw URL otherwise, plus language, format,
   translate_to), return that existing entry instead of creating a new one.
   A re-submission of an already-`completed` video with the same parameters
   surfaces the existing completed entry (cache hit, no new row, no charge).
5. Insert the `transcript_requests` row (`status = queued`), add the BullMQ job,
   store `bullmq_job_id`, return `202` with the entry.

### Routes

All transcript routes live under `/me/transcripts` (dashboard) and `/v1`
(API). There is no `/me/jobs`.

| Method & path | Purpose |
|---|---|
| `POST /me/transcripts` | Enqueue a request; returns the new `queued` entry. Replaces the old blocking `GET /me/transcript`. |
| `GET /me/transcripts` | Paginated list, including queued/processing rows. |
| `GET /me/transcripts/:id` | One entry; `result`/`segments` present only when `completed`. |
| `DELETE /me/transcripts/:id` | Cancel a `queued` entry (removes the BullMQ job, sets `status = canceled`). Rejected if already `processing`. |
| `GET /me/transcripts/stream` | SSE stream of status changes for the user. |
| `POST /v1/transcript` | API mirror of enqueue; returns `202` + entry id. |
| `GET /v1/transcript/:id` | API mirror to poll one entry. |

The old `GET /me/transcript` (singular) and `GET /v1/transcript` synchronous
handlers are removed. The list endpoint reads from `transcript_requests`
instead of aggregating `api_requests`.

### SSE

`GET /me/transcripts/stream` (cookie auth) holds an SSE connection. The worker
emits `processing` / `completed` / `failed` / metadata-updated events to the
in-process `EventEmitter`; the SSE handler subscribes and forwards only events
whose entry belongs to the authenticated user. Each event carries the entry id
and new status so the frontend can update the row in place.

Because the worker is in-process, no Redis pub/sub is needed. If the worker is
ever moved to a separate service, the SSE layer must switch to BullMQ
`QueueEvents` / Redis pub/sub — noted as a constraint, not built now.

### Frontend

- Submitting a URL is non-blocking: `POST /me/transcripts` → receive the
  `queued` entry → clear the input so the user can immediately submit another.
- A single **transcript list** renders every entry with a status badge —
  Queued, Processing, Done, Failed. One SSE connection is opened while the list
  is mounted; if it drops, the list falls back to polling `GET /me/transcripts`.
- Queued/processing rows show metadata (title, channel, thumbnail, duration)
  when known, and a placeholder in place of the transcript.
- A `completed` row is clickable → opens the transcript viewer using the
  entry's stored `result` (no new fetch, no credit charge).
- A `failed` row shows the error message and a **Retry** button that
  re-enqueues the same request.
- When the request originates from the YouTube browse UI, the known metadata
  (title/channel/thumbnail/duration) is sent in the `POST` body so the queued
  row renders fully populated immediately.

## Edge cases

| Edge case | Handling |
|---|---|
| Long-running transcription drops the HTTP connection | Work runs in the worker, decoupled from any HTTP request. |
| User wants to submit more requests while one runs | Enqueue returns immediately; no blocking. |
| Transient YouTube IP-block | BullMQ retries 3× with exponential backoff. |
| Permanent failure (no captions, bad URL) | Re-thrown as `UnrecoverableError`; no retry, marked `failed`. |
| Worker crash mid-request | BullMQ stalled-job detection requeues it. |
| Duplicate / double submit | De-dup returns the existing queued/processing/completed entry. |
| User over-queues with low balance | Credit gate rejects `402` at enqueue. |
| One user floods the queue | 50-request pending cap rejects `429`. |
| Deploy restarts the service | Queued jobs persist in Redis; the worker resumes on boot. |
| Render free Redis evicts keys | Requires `maxmemory-policy noeviction`; startup logs a warning if not set. |
| Result display after async switch | `result` JSON stored on the row; `GET /me/transcripts/:id` is one read, no upstream call. |
| Cancel a request already transcribing | Rejected — cancel is `queued`-only; an `active` Whisper run cannot be force-killed. |

## Operational notes

- Render's free Redis can evict keys under memory pressure. BullMQ requires
  `maxmemory-policy noeviction` on the keyvalue service; the app logs a warning
  at startup if the policy is anything else.
- Worker concurrency stays at 2 so two parallel yt-dlp/Whisper runs do not OOM
  the 512 MB instance. Tunable via `QUEUE_CONCURRENCY`.
- Retention: a BullMQ repeatable job deletes `transcript_requests` rows older
  than 30 days; BullMQ's own Redis records use `removeOnComplete` /
  `removeOnFail` limits.
- New env vars: `QUEUE_CONCURRENCY` (default 2). `REDIS_URL` is reused.

## Out of scope

- Bulk playlist/channel async processing.
- A separate Render worker service.
- Migrating historical `api_requests` history into the new list.
- Email/push notifications on completion (SSE only).
