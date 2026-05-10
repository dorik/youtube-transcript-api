# YouTube and Whisper Fetchers

## What this is

When the transcript endpoint can't find a cached copy, it has to actually go get the transcript. That work happens in this feature: a small fetcher layer that exposes a single function ("get me the transcript for this video id and language") and hides two very different implementations underneath it. The first implementation calls YouTube directly to grab the video's existing captions. The second falls back to OpenAI's Whisper to transcribe the audio when no captions exist. The orchestrator never has to care which one ran — it just gets back a list of segments, the actual language code, and a `source` tag of either `native` or `whisper`.

This feature also owns the metadata fetch (oEmbed for title, channel, thumbnail) because it's the same family of concerns: external calls to YouTube that can fail in interesting ways. And it owns the production proxy story, because YouTube blocks datacenter IPs and our backend lives on one — without a residential proxy, the native path silently fails in production. That last point is the most important thing in this doc to internalize: the architecture works in dev because it doesn't have to deal with YouTube's IP filtering, and works in prod ONLY when the proxy is configured.

## Backend

### Schema

This feature does not own any tables of its own. It writes to `cached_transcripts` (defined in `database-schema.md`) when a fresh fetch succeeds, but the orchestrator owns the cache write — the fetcher is pure: input is a video id and language, output is segments plus a language code and source tag.

### The unified fetcher interface

There is one entry point used by the transcript orchestrator. It takes a video id, a requested language (or `auto`), and a small options bag for the proxy/stub flags. It returns either a successful result with `{ segments, language, source }` or throws a typed error. Internally, it tries the native path first and falls back to Whisper if and only if the native path fails specifically because the video has no captions.

The two paths under the interface:

- **Native captions** via the `youtube-transcript` npm library. Tries the requested language; if unavailable, falls back to whatever YouTube returns by default. Returns segments shaped `{ start, dur, text }` and the actual language code.
- **Whisper transcription** via OpenAI's audio API. Used only when native captions don't exist. Has a stub mode for dev.

A clear distinction between failure modes matters here: if YouTube says "this video has no captions in any language" we fall back to Whisper. If YouTube says "I don't know who you are" or "rate limited" or "video is private," that's NOT a missing-captions case — we propagate the error, no Whisper fallback. The transcript endpoint then surfaces an appropriate error code (502, 429, 404 `VIDEO_NOT_FOUND`, etc.).

### Native fetcher logic

The native path uses the `youtube-transcript` library, which scrapes YouTube's caption endpoints. It accepts a video id and an optional language code.

**Language handling.** When the orchestrator passes `language=auto`, the fetcher asks for the default — whatever YouTube hands back, that's what we cache and return. When the orchestrator passes a specific code (say `es`), the fetcher asks for that. If YouTube doesn't have Spanish captions for the video, the library throws; we catch and re-try with no language specified (the default). The `language` field in the returned result is the actual content language, not the requested one. The orchestrator decides whether to translate (if the user asked for `translate_to`).

**Segment normalization.** The library returns objects with `text`, `duration`, and `offset` (in milliseconds in some versions, seconds in others). We normalize to `{ start, dur, text }` with both times in floating-point seconds. Text is HTML-decoded (the library sometimes returns `&amp;`, `&#39;`, etc.) and trimmed; empty segments are dropped.

**Error classification.** The library throws a few different errors. `NoTranscriptError` (or whatever the equivalent is in the version we pin) is the only one that triggers the Whisper fallback. Everything else — network failures, 429s, parse errors — propagates as an upstream error. The orchestrator turns these into 502 / 503 with code `UPSTREAM_ERROR`.

### Whisper fallback

When the native path fails with a "no captions" error, the orchestrator calls the Whisper path. There are two modes.

**Stub mode** (`STUB_WHISPER=true`, default in dev). Returns canned segments — a small array of `{ start, dur, text }` covering 30-second chunks for the first few minutes of the video, with placeholder text. This exists so the rest of the system (credit math, formatting, caching, translation) can be exercised without a real Whisper run, which is slow and expensive. Stub mode reports `source: 'whisper'` so the cache write and audit log look real.

**Real mode** (`STUB_WHISPER=false`). The path is:

1. **Download audio.** Use `yt-dlp` to download the audio track of the video. yt-dlp is invoked as a subprocess and writes to a temp file. Audio-only download is significantly smaller than video and faster.
2. **Trim if needed.** OpenAI's Whisper has a 25 MB upload limit. If the downloaded audio is larger, use `ffmpeg` to re-encode at a lower bitrate (say 32 kbps mono mp3) until it fits. For very long videos this could mean accepting some quality loss; the alternative would be chunking, which adds complexity we defer.
3. **Upload and transcribe.** POST the audio file to OpenAI's audio transcriptions endpoint with `response_format: verbose_json` so we get per-segment timestamps. Pass the requested language as a hint if the orchestrator asked for one; otherwise let Whisper detect.
4. **Normalize.** Whisper returns segments with `start`, `end`, and `text` (plus other fields we ignore). Convert to `{ start, dur, text }` where `dur = end - start`. Strip the audio file from disk.
5. **Return.** `{ segments, language: <whisper's detected language or the hint>, source: 'whisper' }`.

**Real-mode dependencies.** `yt-dlp` and `ffmpeg` must be installed on the system. In production on Render, this means the Dockerfile installs both (apt packages, plus a binary download for yt-dlp). The deploy doc handles the actual install; this doc just notes the dependency.

**Real-mode failure handling.** Each substep can fail. yt-dlp can fail because the video is private, age-restricted, region-locked, or because YouTube changed something. ffmpeg can fail on corrupt audio. OpenAI can fail with rate limits or 5xx. Each failure is caught, logged with detail, the temp file is cleaned up, and an upstream error is propagated. The orchestrator turns these into 502 with code `UPSTREAM_ERROR` (or 422 `NO_TRANSCRIPT` if we decide Whisper failure is the same as no transcript existing — that's a product call; defaulting to 422 keeps the error surface simpler for callers).

### Metadata via oEmbed

YouTube provides a public oEmbed endpoint at `https://www.youtube.com/oembed?format=json&url=<video_url>` that returns title, author (channel), thumbnail URL, and a few other fields. No API key, no auth, no quota that matters at our scale. The fetcher exposes a small helper that takes a video id, builds the URL, calls oEmbed, and returns `{ title, channel, thumbnail_url, duration }`. Duration isn't in oEmbed directly — it can come from the native caption fetch (segments' last end time) or be omitted if Whisper-only.

oEmbed can fail in two ways: a network error (treated as upstream, 502) and a 404 (the video doesn't exist or is private). The 404 case is where the transcript endpoint's `VIDEO_NOT_FOUND` comes from.

oEmbed responses are cached in Redis with a long TTL (say 24 hours) since title and channel rarely change. The cached metadata is stored in `cached_transcripts.metadata` for any video we've ever transcribed.

### The proxy gotcha

This is the most important thing in this doc to remember: **YouTube blocks datacenter IPs.** If you call YouTube's caption endpoints from an AWS, GCP, Azure, Render, or similar IP, you'll get either a 429, a captcha page, or empty results. From a residential IP (your laptop, a home internet connection), the same call works fine. This is YouTube's anti-scraping measure and it has been in place for years.

The practical implication: in production, the native fetcher will not work without a residential proxy. Without one, only videos already in the shared `cached_transcripts` cache can be served, and any first-request for a new video will fail. Whisper will keep working (yt-dlp can sometimes work from datacenter IPs, but is also flaky) but Whisper is expensive and slow — falling back to it for every fresh request is not a viable production strategy.

The supported solution is a residential proxy provider — Webshare and Bright Data are the two referenced in the deploy doc. The fetcher accepts an HTTP/HTTPS proxy URL via env var (`YT_PROXY_URL`); if set, all native fetches and yt-dlp downloads route through it. In dev, `STUB_PROXY=true` skips the proxy entirely (we're running on a residential IP anyway).

The deploy doc covers the actual provider setup. This doc just says: production needs the proxy URL configured, and the fetcher honors it.

### Stubs in summary

- `STUB_WHISPER=true` — Whisper returns canned segments. Native fetcher unaffected.
- `STUB_PROXY=true` — Native fetcher and yt-dlp skip the proxy. Use in dev. Production must set this to false and configure `YT_PROXY_URL`.

There is no `STUB_YOUTUBE` — the native fetcher always calls YouTube. In dev, you simply rely on YouTube being reachable from your laptop (which it is) and on test fixtures of cached transcripts in your local Postgres.

## Frontend

This feature has no frontend. It's pure backend infrastructure, consumed by the transcript endpoint orchestrator.

## Dependencies

- `database-schema.md` — `cached_transcripts` (the orchestrator writes to it; the fetcher is pure).
- `transcript-endpoint.md` — the only consumer of this fetcher in MVP.
- The deploy story (separate doc) — must install `yt-dlp` and `ffmpeg` in the production container, and must provision a residential proxy.

## Verification

In dev:

1. With `STUB_WHISPER=false` and `STUB_PROXY=true`, hit the transcript endpoint with a popular video URL. Confirm a 200 response with `source: 'native'` and reasonable segments.
2. With the same env, hit it with a video that has no captions (you can find one on YouTube — many vlogs and short tests don't have them). Confirm a 200 with `source: 'whisper'` and the slower latency consistent with a real Whisper run.
3. With `STUB_WHISPER=true`, repeat step 2. Confirm a fast 200 with canned segments.
4. Hit oEmbed directly with a known-good and known-bad video id; confirm shape of success and 404 of failure.

In production:

5. Deploy with `STUB_PROXY=false` but no `YT_PROXY_URL` set. Hit the transcript endpoint with a video that's NOT in the shared cache. Confirm an upstream error or empty result — this is the failure mode we're documenting, not a passing test.
6. Set `YT_PROXY_URL` to a valid Webshare endpoint, redeploy. Hit the same endpoint with the same video. Confirm a 200 with `source: 'native'`.
7. Hit a video that's already in `cached_transcripts`. Confirm a 200 with `source: 'cache'` regardless of proxy state — cached responses don't touch YouTube.
8. Look at the Render logs during a fresh fetch and confirm proxy-related connection lines (or their absence with `STUB_PROXY=true`).

If steps 1–4 pass in dev and 5–8 confirm the expected production behavior, the fetcher is working as specified and the proxy gotcha is properly understood.
