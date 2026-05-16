# Public Bulk Transcript API & Playground Playlist/Channel — Design

- **Date:** 2026-05-16
- **Status:** Approved (pending spec review)
- **Branch:** `feat/queue`

## Problem

The async-transcript-queue rework removed the synchronous `/v1/playlist/transcripts`
and `/v1/channel/transcripts` endpoints (backend plan Task 13), and reduced the
playground to single-video only (frontend plan Task 9). As a result:

- The **public `/v1` API has no way to transcribe a playlist or channel** in one
  call. An API consumer must call a discovery endpoint and then loop
  `POST /v1/transcript` per video themselves.
- The **playground** lost its Playlist and Channel tabs — it can only demo
  single-video transcription.

The old endpoints were *synchronous*: one HTTP request expanded the playlist and
transcribed every video before responding. That is exactly the dropped-connection
failure mode the queue was built to eliminate, so they cannot simply be restored.

## Goals

- A public, API-key-authed **bulk transcript endpoint** that expands a
  playlist/channel and queues per-video transcription on the existing queue.
- Restore the playground's **Videos / Playlist / Channel** tabs.
- Stay fully async — the bulk endpoint enqueues and returns immediately; the
  consumer polls for results.

## Non-goals

- Synchronous bulk transcription. Explicitly rejected — it reintroduces the
  long-request/dropped-connection problem the queue exists to solve.
- Changes to the dashboard bulk flow. `POST /me/transcripts/bulk` already works.
- A new results UI in the playground — the existing `BulkResultsList` is reused.

## Decisions

| # | Decision |
|---|----------|
| 1 | This **reverses** the decision "There is no API bulk endpoint" in `2026-05-16-async-transcript-queue-design.md`. That spec's Routes section and Decision #9 commentary are updated to record the new `/v1` bulk endpoint. |
| 2 | `POST /v1/transcripts/bulk` is **async / queue-backed**. It expands the source, creates a `transcript_batches` row, queues one job per video, and returns `202` with the batch and its queued entries — never finished transcripts. |
| 3 | Batch status is polled via `GET /v1/transcripts/batches/:id`. |
| 4 | Playlist/channel **expansion is synchronous at submit time**, capped at **100 videos** per request (same cap as the dashboard bulk route). Over the cap → `400`. |
| 5 | Channel supports three modes: `videos` (the channel's uploads), `latest` (most recent), `search` (search within the channel — requires a query). |
| 6 | The playground's bulk tabs default the result `limit` to **5**, matching the previous playground. |
| 7 | The expansion logic (browse-service call → `BatchVideoInput[]`) is **extracted into a shared helper** so the `/v1` bulk route and the dashboard `/me/transcripts/bulk` route do not duplicate it. |

## Backend design

Two new routes in `backend/src/routes/transcript.ts` (the public `/v1` router),
both `apiKeyAuth` + `rateLimit`:

### `POST /v1/transcripts/bulk`

- **Body** (Zod-validated): exactly one of `playlist` / `channel` / `urls`, plus
  optional `channelMode` (`videos` | `latest` | `search`, default `videos`),
  `channelQuery` (required when `channelMode === 'search'`), `limit`, and the
  shared transcript options `format` / `language` / `native_only` / `translate_to`.
- **Expansion:** synchronously resolve the source to a video list via
  `youtubeBrowseService`:
  - `playlist` → `listPlaylistVideos`
  - `channel` + `videos`/`latest` → `listChannelVideos`
  - `channel` + `search` → `searchYouTube` scoped to the channel
  - `urls` → parse each URL with `extractVideoId`
  Reject `400` if the resolved list exceeds 100 videos.
- **Enqueue:** reuse `enqueueBatch` (which already applies the credit gate and the
  per-user pending cap, creates the `transcript_batches` row, and queues the jobs).
- **Response:** `202 { batch, requests }` — the batch row and the expanded videos
  as `queued` `TranscriptRequest` entries. Identical shape to the dashboard
  `POST /me/transcripts/bulk` response.

### `GET /v1/transcripts/batches/:id`

- Mirror of `GET /me/transcripts/batches/:id`. Reuses `getBatch` (user-scoped),
  `getBatchProgress`, `listBatchRequests`.
- **Response:** `{ batch, progress, requests }` where `progress` is
  `{ queued, processing, completed, failed, canceled }`.
- `404` (`NotFoundError`) if the batch does not exist or is not owned by the
  API key's user.

### Shared expansion helper

The dashboard `POST /me/transcripts/bulk` handler in `meTranscripts.ts` currently
inlines the expand-and-build-`BatchVideoInput[]` logic. That logic moves into a
shared helper (in `transcriptRequestService.ts` or a small `bulkExpansion`
module) consumed by both routes. The dashboard route keeps its current behaviour;
the `channelMode` / `channelQuery` parameters are added to the shared schema and
simply left unused by the dashboard UI for now.

### Route ordering

`/v1/transcripts/bulk` and `/v1/transcripts/batches/:id` live under the `transcripts`
(plural) path; the existing `/v1/transcript/:id` is a different path, so there is
no Express param-route collision. The literal `/transcripts/bulk` is registered
before `/transcripts/batches/:id`.

## Frontend design — playground

Restore the three tabs in `frontend/src/features/playground/`:

- **Tabs:** `Videos | Playlist | Channel`, reinstating the `tab` state and the
  shadcn `Tabs` components removed in frontend Task 9.
- **Playlist tab:** playlist URL input + a result `limit` input (default 5).
- **Channel tab:** channel URL input + a `channelMode` selector
  (`videos` / `latest` / `search`) + a `channelQuery` input shown only for
  `search` + a `limit` input.
- **Submit (playlist/channel):** a new `runBulk` helper — `POST /v1/transcripts/bulk`
  with the Bearer key → receive `{ batch, requests }` → poll
  `GET /v1/transcripts/batches/:id` every ~3s until
  `progress.queued + progress.processing === 0` → return the final request list.
  This mirrors the existing single-video `runOne` enqueue-and-poll helper.
- **Results:** each batch request entry maps to a `BulkResultEntry`
  (`ok: true` with `data` + `requestId` for `completed`; `ok: false` with `error`
  for `failed`/`canceled`). Rendered by the existing `BulkResultsList` —
  rows fill in live as polling progresses.
- **curl preview:** the bulk tabs show a single `POST /v1/transcripts/bulk`
  command (the async endpoint makes it one call again).
- **Auth:** playlist/channel require a plaintext API key, same as the Videos tab
  (the public API has no cookie-auth fallback).

The playground continues to call the public API through the raw `api()` Bearer
adapter (the established playground exception), not the React Query service layer.

## Edge cases

| Edge case | Handling |
|-----------|----------|
| Playlist/channel resolves to > 100 videos | `POST .../bulk` rejects `400`; playground shows the error toast. |
| Private / empty / blocked playlist or channel | Expansion fails; `400`/upstream error returned synchronously; no batch created. |
| Some videos in the batch fail | Each entry fails independently; the batch row shows the failed count; other rows still complete. |
| Consumer can't afford all N videos | `enqueueBatch`'s credit gate rejects `402`; nothing is enqueued. |
| `channelMode: 'search'` with no query | Rejected `400` at body validation. |
| Polling a batch that never settles | Bounded in practice by the queue draining; the playground polls until `queued + processing === 0`, the same unbounded-but-terminating model as single-video `runOne`. |

## Out of scope

- Dashboard UI changes (the dashboard already does playlist/channel bulk).
- Synchronous bulk transcription.
- Exposing the channel `latest`/`search` modes in the dashboard UI.
