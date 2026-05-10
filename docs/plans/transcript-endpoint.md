# The Transcript Endpoint

## What this is

`GET /v1/transcript` is the product. Everything else in the system — accounts, keys, billing, the dashboard — exists to make this single endpoint useful and accountable. A customer sends a YouTube URL, optionally specifies a format and a target language, and gets back a structured transcript along with credit-usage headers. This doc covers the endpoint's contract (params, responses, errors), the orchestration that runs behind it (cache → fetch → meta → credits → translate → cache write → format → log), and the rate-limiting that keeps any one key from monopolizing the system.

The endpoint is intentionally one route doing one thing well. There is no `/v1/translate`, no `/v1/whisper`, no `/v1/transcribe`. Translation is a parameter; Whisper is an automatic fallback the customer never has to think about. The simpler the surface, the easier the API is to integrate, and the easier it is for us to keep the contract stable as we change implementation underneath.

This endpoint depends on a lot of other features — the cache layer, the YouTube and Whisper fetchers, the formatters, the credit system, the rate limiter, the Bearer middleware. Each of those has its own doc. This one focuses on the orchestration that ties them together and the externally visible contract.

## Backend

### Endpoint

There is one route in this feature: `GET /v1/transcript`. It is Bearer-authed, rate-limited, and takes its input as query parameters.

Query parameters:

- `url` — required. A YouTube URL in any common shape — `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/shorts/…`, with or without query strings. The URL is normalized into an 11-character video id; if it can't be, the endpoint returns 400 with code `INVALID_URL`.
- `format` — optional, defaults to `json`. One of `json`, `text`, `srt`, `vtt`. Anything else is 400 `INVALID_FORMAT`.
- `language` — optional, defaults to `auto`. ISO 639-1 (two-letter) code or the literal `auto`. With `auto`, the fetcher picks whatever language YouTube returns (usually the video's primary). With a specific code, the fetcher requests that language; if unavailable, falls back to `auto` rather than failing.
- `translate_to` — optional, omitted means no translation. ISO 639-1 code. If set and different from the source language, the transcript is translated through the three-tier translator before being returned. If set and equal to the source language, the translation step is skipped (no extra cost).

### Response shapes

The JSON shape (when `format=json`) is:

- `metadata` — `{ video_id, title, channel, thumbnail_url, duration }` from oEmbed.
- `source` — `native`, `whisper`, or `cache`. `cache` means served from the cache layer (the underlying source is preserved in the cached row but the served response reports `cache` so callers can see they got a cached copy).
- `language` — the actual language code of the transcript content. May differ from the requested `language` if `auto` was used or if a fallback happened.
- `segments` — array of `{ start, dur, text }`. `start` and `dur` are floats in seconds. `text` is a single line, no embedded newlines.
- `translated_to` — present only when translation ran; the target language code.

For `format=text`, the response body is plain text with one segment per line, joined by newlines, no timestamps. Content-Type is `text/plain; charset=utf-8`.

For `format=srt`, the body is SRT (numbered cues, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, blank line between cues). Content-Type is `application/x-subrip`.

For `format=vtt`, the body is WebVTT (`WEBVTT` header, `HH:MM:SS.mmm --> HH:MM:SS.mmm`). Content-Type is `text/vtt`.

For all formats, the same response headers are set:

- `X-Credits-Used` — the cost of this request (integer, including translation surcharge).
- `X-Credits-Remaining` — the user's balance after this request.
- `X-Cache` — `HIT` or `MISS`, useful for callers debugging their own integrations.
- `X-Source` — `native`, `whisper`, or `cache`, mirroring the JSON `source` field for non-JSON formats.

### Errors

The error envelope is the same across the entire API: `{ error: true, code, message }`, with the HTTP status code carrying the rough category. Documented codes for this endpoint:

- 400 `INVALID_URL` — couldn't extract an 11-char video id from the URL.
- 400 `INVALID_FORMAT` — `format` not one of the four known values.
- 400 `INVALID_LANGUAGE` — `language` or `translate_to` is not a recognized ISO 639-1 code.
- 401 — any of the Bearer middleware failures (see `api-keys.md`).
- 402 `PAYMENT_REQUIRED` — user's credit balance is too low for this request. The body includes the cost and the current balance so the caller can show a useful message.
- 404 `VIDEO_NOT_FOUND` — the URL parsed but oEmbed says the video doesn't exist, is private, or is age-restricted.
- 422 `NO_TRANSCRIPT` — the video has no native captions AND Whisper failed (or is disabled). Rare in practice because Whisper succeeds on almost any video with audible speech.
- 429 `RATE_LIMITED` — per-key rate limit exceeded. Includes a `Retry-After` header.
- 502 / 503 — upstream errors from YouTube or OpenAI that aren't customer-actionable. Logged with full detail server-side; the response body carries a generic code like `UPSTREAM_ERROR`.

### Orchestration

The handler runs through a fixed pipeline. Each step has clear inputs and outputs and can fail with a documented error.

1. **Authenticate.** Bearer middleware (covered in `api-keys.md`) resolves the user and key, or aborts with 401.
2. **Rate-limit.** A token-bucket check against Redis, keyed by `api_key_id`. Roughly 100 requests per minute per key in MVP, with the exact number tunable per plan later. On overflow, return 429 with `Retry-After`.
3. **Validate.** Zod schema parses the query params, normalizes the URL into a video id, and rejects bad input with 400 plus the appropriate code.
4. **Cache lookup.** Try Redis first (key: `transcript:<video_id>:<language>`), then `cached_transcripts` table on miss. A hit at either tier short-circuits to step 7 (translate or skip), 8 (format), 9 (respond), 10 (log) — but skips the fetch and the cache write.
5. **Fetch.** On miss, call the unified fetcher described in `youtube-and-whisper.md`. It tries native YouTube captions first, falls back to Whisper if there are none. Returns segments and the actual language code, plus a `source` of `native` or `whisper`. If both fail, return 422 `NO_TRANSCRIPT`.
6. **Metadata.** In parallel with or just after the fetch, call YouTube's oEmbed endpoint for title, channel, and thumbnail. If oEmbed says the video doesn't exist, return 404 `VIDEO_NOT_FOUND` (this can also abort the request before fetching if oEmbed is checked first — the implementation chooses, but the user-visible behavior is the same).
7. **Credits.** Compute the cost: a base cost per request (cheap for native, more expensive for Whisper), plus a surcharge if `translate_to` is set. Inside a single Postgres transaction, check the user's `credit_balance`, decrement it, and insert a `credit_transactions` row with the post-decrement balance. If the balance is too low, abort with 402 `PAYMENT_REQUIRED` and do not deduct. Cache hits may have a reduced cost or zero cost — that's a pricing decision documented in the credit system feature, but the orchestrator just calls the cost function.
8. **Translate (optional).** If `translate_to` was passed and differs from the actual transcript language, run the three-tier translator. The output replaces the segments' text in-place; structure (`start`, `dur`) is preserved. Translation failures fall through tiers; if all tiers fail, return 502.
9. **Cache write.** On a fresh fetch (not on cache hits), write the segments + metadata to both Redis (with a short TTL, say a few hours) and Postgres (no TTL, canonical). Note: translated transcripts are also cached, keyed by `<video_id>:<translate_to>` so future requests for the same translation are free. Source-language transcripts and translated transcripts both live in `cached_transcripts` — the `language` column is the actual content language.
10. **Format.** Run the segments through the requested formatter (json/text/srt/vtt). The formatter is pure — same input always produces same output.
11. **Respond.** Set the headers, return the body with the right content type.
12. **Log.** Insert a row into `api_requests` with the user, key, video, language, format, source, cost, status, and latency. This write is fire-and-forget; the response has already been sent. Failures here are logged server-side but don't affect the customer.

### Logic and edge cases

**The fetch and the meta call can race.** oEmbed is fast (typically under 200ms). The native caption fetch is also usually fast but can be slow. Running them in parallel saves wall-clock time on cache misses. If oEmbed returns 404, we cancel the fetch (or let it complete and discard) and return 404 to the caller.

**Cache hits skip credit deduction or charge less.** The exact pricing policy is in the credit system doc, but the orchestrator's contract is: it asks the cost function for a number, and that number reflects whatever policy is in force. The cost function knows about cache hits via the `source = 'cache'` flag.

**Translation result caching.** A translated transcript is cached as a separate row, keyed by `(video_id, translate_to)`. So a request for `en` then a request for `es` translation produces two cache rows. A subsequent request for `translate_to=es` against the same video is a cache hit and skips both the fetch and the translate steps.

**Refunds on partial failure.** If credits are deducted and then a downstream step fails (translation tier-down all fail, or formatter blows up), the orchestrator must refund the credits. This is done by inserting a `credit_transactions` row with a positive delta and reason `refund`, and updating `users.credit_balance` accordingly. Same transaction as the original deduction is ideal; if not possible, a compensating transaction is acceptable.

**Latency target.** A cache hit should respond in under 50ms (Redis or Postgres lookup + format + log). A native fetch is typically 500ms–2s. A Whisper transcription is 5–30s depending on length. Translation adds 500ms–5s. None of these need to be enforced as hard timeouts in MVP; they're just the shape callers should expect.

**Audit row is the truth.** The `api_requests` table is the canonical record of what happened on every request. Billing reconciliation, usage analytics, and customer support all read from it. Make sure every code path that returns a response also writes a row, including error paths — a 401 from Bearer auth doesn't write a row (because we don't know the user), but a 402 PAYMENT_REQUIRED does (we do know, and that's a meaningful event).

## Frontend

This endpoint is consumed by two surfaces: the in-browser playground and the transcript viewer. Both are dashboard pages and both call the public API with the user's session-bound test key (or via a session-authed proxy route, depending on implementation choice — see the playground feature doc). Customers also call this endpoint directly from their own code; the docs site shows curl examples.

There is no dedicated frontend in this doc — the playground and viewer have their own.

## Dependencies

- `api-keys.md` — Bearer middleware authenticates every request here.
- `database-schema.md` — `cached_transcripts`, `api_requests`, `credit_transactions`.
- `youtube-and-whisper.md` — the fetcher this endpoint orchestrates.
- The cache feature (Redis + Postgres two-tier) — the lookup and write steps.
- The credit system feature — pricing, deduction, refund.
- The rate-limiting feature — the per-key token bucket.
- The formatters feature — json/text/srt/vtt rendering.
- The translation feature — the three-tier chain.

## Verification

A working integration looks like this:

1. With a valid key, fetch a popular short video in default JSON:
   `curl -H "Authorization: Bearer yt_live_…" "https://api.example.com/v1/transcript?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"`
   Confirm 200, valid JSON with `metadata`, `segments`, `source: 'native'` (first time) or `'cache'` (second time), and the `X-Credits-*` headers.
2. Repeat the same request and confirm `X-Cache: HIT` and `source: cache`. Compare the credit cost vs the first call.
3. Request `format=srt` for the same URL. Confirm a valid SRT body with numbered cues.
4. Request `translate_to=es` for the same URL. Confirm the segments are in Spanish and `translated_to: 'es'` is in the response. Repeat and confirm cache hit.
5. With a key whose user has zero credits, hit the endpoint. Confirm 402 with code `PAYMENT_REQUIRED` and the cost+balance in the body. Confirm the credit_transactions table did NOT get a row for this attempt.
6. Hit the endpoint with `url=https://www.youtube.com/watch?v=invalid_id`. Confirm 400 `INVALID_URL` (id length wrong) or 404 `VIDEO_NOT_FOUND` (id length right but oEmbed 404s).
7. Burst 200 requests in five seconds with the same key. Confirm later requests start returning 429 with `Retry-After` headers.
8. After all of the above, query the `api_requests` table for the test user and confirm one row per request — including the 402 and the 429.

If all eight pass, the endpoint is working as specified.
