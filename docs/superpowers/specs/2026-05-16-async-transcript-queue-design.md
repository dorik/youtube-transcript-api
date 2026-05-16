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
- Bulk playlist/channel submissions fan out into the same queue — they are not
  a slow synchronous loop.
- A single unified transcript list shows queued, processing, completed, and
  failed entries — there is no separate "jobs" list or route. Bulk entries are
  grouped under a batch header in the same list.
- Live status updates via Server-Sent Events.
- Transient upstream failures retry automatically; permanent failures do not.
- Worker crashes mid-request do not strand an entry in `processing` forever.

## Non-goals

- A separate Render worker service. The worker runs in-process (see Decisions).
- Backfilling pre-existing transcript history into the new list.
- Queued playlist/channel *expansion*. The list of video IDs is resolved
  synchronously at submit time (see Decisions); only the per-video transcription
  is queued.

## Decisions

| # | Decision |
|---|----------|
| 1 | **Async everywhere.** Both `/me/transcripts` (dashboard) and `/v1/transcript` (API) enqueue and return an entry id. This is a breaking change for `/v1/transcript`; acceptable while still Phase 1 MVP. |
| 2 | **BullMQ** is the queue library, backed by the existing Render Redis. |
| 3 | **In-process worker.** The BullMQ `Worker` runs inside the existing Express service (no paid Render worker service). Concurrency is low to fit the 512 MB box. |
| 4 | **Gate at enqueue, charge on success.** Enqueue is rejected if the user cannot afford it; 1 credit is deducted only when a request completes with fresh work (cache hits remain free). Failed requests cost nothing — no refund flow. |
| 5 | **SSE** for live status updates to the dashboard. |
| 6 | **One unified list.** Queued/processing/completed/failed entries all live in the transcript list. No "jobs" concept in routes or UI. |
| 7 | Per-user pending cap: **200** queued/processing requests (raised from a single-request scale to accommodate a full playlist). |
| 8 | Worker concurrency: **2** (env-configurable via `QUEUE_CONCURRENCY`). |
| 9 | Cancellation is allowed only while an entry is `queued`. Cancelling a batch cancels all its still-`queued` children. |
| 10 | **Bulk = fan-out.** A playlist/channel/list submission expands into N individual `transcript_requests` rows, each queued like a single request. There is no separate bulk processing path. |
| 11 | Playlist/channel **expansion is synchronous** at submit time, capped at **100 videos per batch**. |

## Architecture

### Data model

New migration `013_transcript_queue.sql`:

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
  -- Grouping. NULL for a standalone single request; set for bulk fan-out.
  batch_id         UUID         FK → transcript_batches(id) ON DELETE CASCADE
  batch_position   INTEGER                        -- ordering within the batch
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  started_at       TIMESTAMPTZ
  completed_at     TIMESTAMPTZ

  INDEX (user_id, created_at DESC)
  INDEX (status)
  INDEX (batch_id)
```

A bulk submission groups its rows under one batch:

```
transcript_batches
  id          UUID PK DEFAULT gen_random_uuid()
  user_id     UUID NOT NULL FK → users(id) ON DELETE CASCADE
  kind        VARCHAR(10)  NOT NULL          -- 'playlist' | 'channel' | 'videos'
  source_url  VARCHAR(500)                   -- the playlist/channel URL, if any
  label       VARCHAR(512)                   -- playlist/channel title, for display
  total       INTEGER      NOT NULL          -- videos expanded into the batch
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()

  INDEX (user_id, created_at DESC)
```

Batch progress is **derived**, not stored — `SELECT status, count(*) FROM
transcript_requests WHERE batch_id = $1 GROUP BY status` — so there are no
counter columns to keep consistent.

De-duplication of identical requests is enforced in application code (see the
Enqueue gate, below) rather than by a DB unique constraint, because `video_id`
is `NULL` until resolved and a `canceled`/`failed` entry must not block a fresh
request for the same video.

Migration `013` also **drops** the dead `jobs` / `job_videos` tables (migration
`010`) — they are fully superseded by `transcript_requests` + `transcript_batches`.

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

### Enqueue gate (single request)

`POST /me/transcripts` and `POST /v1/transcript` perform, in one transaction:

1. **Validate** the request (URL, format, language) — same Zod schema as today.
2. **Credit gate** — reject `402` if
   `balance − (count of the user's queued/processing requests) < 1`.
3. **Pending cap** — reject `429` if the user already has ≥ 200 queued/processing
   requests.
4. **De-dup** — if an identical `queued`/`processing` request exists (same user,
   resolved `video_id` when known or raw URL otherwise, plus language, format,
   translate_to), return that existing entry instead of creating a new one.
   A re-submission of an already-`completed` video with the same parameters
   surfaces the existing completed entry (cache hit, no new row, no charge).
5. Insert the `transcript_requests` row (`status = queued`), add the BullMQ job,
   store `bullmq_job_id`, return `202` with the entry.

### Bulk enqueue

`POST /me/transcripts/bulk` accepts a playlist URL, a channel URL, or an
explicit list of video URLs, plus the shared format/language/translate_to
options. It is a **dashboard-only** route — the public API has no bulk
endpoint; an API consumer loops `POST /v1/transcript` per video instead (each
call is instant since enqueue is async). Steps:

1. **Expand** synchronously via `youtubeBrowseService` into a list of video
   URLs (with title/channel/thumbnail/duration where the listing provides them).
   Reject `400` if the batch exceeds 100 videos.
2. **Cache pre-check** — for each expanded video, do a fast cache read for the
   requested params. Cached videos will become rows inserted directly as
   `completed` (0 credits, no queue job). Let `N` be the count of the remaining
   uncached videos that need real queue work.
3. **Credit gate** — reject `402` if `balance − (queued/processing count) < N`.
   The whole batch is rejected rather than partially enqueued.
4. **Pending cap** — reject `429` if `(queued/processing count) + N > 200`.
5. In one transaction, insert the `transcript_batches` row and one
   `transcript_requests` row per expanded video (`batch_id` set,
   `batch_position` = listing order) — cached videos as `completed`, the rest
   as `queued`. Enqueue the N BullMQ jobs, return `202` with the batch and its
   entries.

Every video in a batch is exactly one row owned by that batch, so batch
progress (`total` vs. derived status counts) is unambiguous. The single-request
de-dup rule above does not cross batch boundaries. Cache-hit rows inserted
directly as `completed` also get their `api_requests` log row written at
enqueue time (the worker writes it for queued rows), so usage charts stay
complete.

### Routes

All transcript routes live under `/me/transcripts` (dashboard) and `/v1`
(API). There is no `/me/jobs`.

| Method & path | Purpose |
|---|---|
| `POST /me/transcripts` | Enqueue one request; returns the new `queued` entry. Replaces the old blocking `GET /me/transcript`. |
| `POST /me/transcripts/bulk` | Expand a playlist/channel/URL-list and enqueue the batch; returns the `transcript_batches` row + entries. |
| `GET /me/transcripts` | Paginated list, including queued/processing rows; each carries its `batch_id`. |
| `GET /me/transcripts/:id` | One entry; `result`/`segments` present only when `completed`. |
| `GET /me/transcripts/batches/:id` | Batch summary (derived progress counts) + its entries. |
| `DELETE /me/transcripts/:id` | Cancel a `queued` entry (removes the BullMQ job, sets `status = canceled`). Rejected if already `processing`. |
| `DELETE /me/transcripts/batches/:id` | Cancel a batch — cancels every still-`queued` child. |
| `GET /me/transcripts/stream` | SSE stream of status changes for the user. |
| `POST /v1/transcript` | API mirror of single enqueue; returns `202` + entry id. |
| `GET /v1/transcript/:id` | API mirror to poll one entry. |

There is no API bulk endpoint — bulk fan-out is a dashboard-only feature. API
consumers transcribe a playlist by looping `POST /v1/transcript` per video.

Literal sub-paths (`/bulk`, `/stream`, `/batches/...`) are registered before
the `/:id` param route so Express matches them correctly.

The old `GET /me/transcript` (singular) and `GET /v1/transcript` synchronous
handlers are removed, as is the synchronous `runBulkTranscripts` function in
`transcriptService.ts` (superseded by bulk fan-out). The list endpoint reads
from `transcript_requests` instead of aggregating `api_requests`.

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
- Bulk submission: pasting a playlist/channel URL (or multi-selecting in the
  browse UI) calls `POST /me/transcripts/bulk`. Its rows render in the same
  list under a collapsible **batch header** showing the playlist/channel label
  and derived progress (e.g. "*Name* — 12/30 done · 2 failed"), with a
  **Cancel batch** action. Standalone single requests stay flat rows.

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
| One user floods the queue | 200-request pending cap rejects `429`. |
| Deploy restarts the service | Queued jobs persist in Redis; the worker resumes on boot. |
| Render free Redis evicts keys | Requires `maxmemory-policy noeviction`; startup logs a warning if not set. |
| Result display after async switch | `result` JSON stored on the row; `GET /me/transcripts/:id` is one read, no upstream call. |
| Cancel a request already transcribing | Rejected — cancel is `queued`-only; an `active` Whisper run cannot be force-killed. |
| Bulk playlist runs slowly as one request | Each video is an independent queue entry — no synchronous loop. |
| Playlist larger than 100 videos | Bulk enqueue rejects `400`; user can split it. |
| Some videos in a batch fail | Each entry fails independently; batch progress shows the failed count; per-entry Retry still works. |
| Playlist/channel expansion fails (private/empty/blocked) | `POST .../bulk` rejects synchronously with the upstream error; no batch row is created. |
| Bulk submission can't afford all N videos | Whole batch rejected `402`; nothing is enqueued. |

## Operational notes

- Render's free Redis can evict keys under memory pressure. BullMQ requires
  `maxmemory-policy noeviction` on the keyvalue service; the app logs a warning
  at startup if the policy is anything else.
- Worker concurrency stays at 2 so two parallel yt-dlp/Whisper runs do not OOM
  the 512 MB instance. Tunable via `QUEUE_CONCURRENCY`.
- Retention: a BullMQ repeatable job deletes `transcript_batches` and
  standalone `transcript_requests` rows older than 30 days; deleting a batch
  cascades to its child requests. BullMQ's own Redis records use
  `removeOnComplete` / `removeOnFail` limits.
- New env vars: `QUEUE_CONCURRENCY` (default 2). `REDIS_URL` is reused.

## Out of scope

- A separate Render worker service.
- Queued (async) playlist/channel expansion — expansion stays synchronous.
- Migrating historical `api_requests` history into the new list.
- Email/push notifications on completion (SSE only).
