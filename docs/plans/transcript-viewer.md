# Transcript Viewer

## What this is

The viewer is where the product stops feeling like an API and starts feeling like a tool. After a user has fetched a transcript — through the API, through the new-transcript form, or just by clicking a row in their history — the viewer is the page where they actually *use* it. The video plays on the left, every segment of the transcript is listed on the right, the segments highlight as the video plays, and clicking any segment seeks the player to that moment. On top of the video itself there's an optional subtitle overlay that renders the current segment with one word highlighted at a time.

The viewer is also where most of the value-add features live: language switching (if the video has been cached in multiple languages), translation to a new language on demand, format export (JSON / TXT / SRT / VTT), and a search box that filters segments by substring. None of these spend credits — the viewer is reading from cached data the user has already paid for once. New translations do spend credits.

The page is intentionally a single deep page rather than a series of tabs. Everything related to one video lives at one URL: `/dashboard/transcripts/<videoId>`. Bookmarkable. Shareable (in the sense that a teammate with their own account can paste the URL and the viewer will resolve from their own history if they've also fetched the video, or show the "Fetch transcript" CTA if not).

This doc covers the viewer page and the in-player subtitle overlay together, because they ship as a single feature and are operationally inseparable. The overlay is a sub-feature of the viewer, not a standalone surface.

## UI/interaction idea

**Layout.** A two-pane split, sized to the viewport. On desktop the left pane is roughly 60% of the width and contains the embedded YouTube player (16:9, responsive within the pane), with a settings strip directly below it. The right pane is the remaining 40% and contains a header (search box and filters), a tall scrolling list of segments, and a small footer with export buttons. On mobile (under ~900 px width) the panes stack vertically: player on top, segment list filling the rest of the screen below.

**The player.** Standard YouTube IFrame embed using the official YouTube IFrame Player API — not a plain `<iframe src="…/embed/…">`, because we need programmatic control. The player loads the video by id, is muted/unmuted by the user, and is controlled via `seekTo`, `playVideo`, `pauseVideo`. The settings strip below the player contains, left to right: a small "Now playing" timestamp display, a gear icon that opens the subtitle settings popover, a "Hide overlay" toggle, an "Autoscroll" toggle (default on), and a language switcher dropdown that lists the cached languages for this video.

**The segment list.** A virtualised scrolling list (one item per transcript segment). Each segment row shows the segment's start timestamp on the left in a compact monospaced format (`0:00`, `12:34`), and the segment's text on the right. Rows are clickable across their entire area. The currently-playing segment gets a strong accent background and a left-edge accent bar. When autoscroll is on, the active row is kept centred in the visible viewport as the video plays.

**The right-pane header.** A search input that filters segments by substring as the user types — matching segments stay, non-matching segments are hidden. Matched substrings inside visible segments get a yellow highlight. Below the search, two pieces of metadata: the current language (with a small switcher if alternative cached languages exist) and a "Translate to…" dropdown that fires a translation request and replaces the segments in place when it returns.

**The right-pane footer.** Four export buttons in a row: "JSON", "TXT", "SRT", "VTT". Clicking any of them downloads the transcript in that format using the browser's standard "save file" dialog. These can be generated client-side from the cached payload (no backend round-trip needed).

**The subtitle overlay.** An absolutely-positioned div over the YouTube iframe with `pointer-events: none` so clicks pass straight through to YouTube's own player chrome (play/pause, scrubber, fullscreen). The overlay renders the current segment's text in the configured font, with the currently-spoken word emphasised — bolder weight plus a colored highlight behind it. The overlay sits near the bottom of the player by default, with margin from the edge so it doesn't crash into YouTube's progress bar. It has a default semi-transparent dark background behind the text for legibility against any video.

**The settings popover.** Triggered by the gear icon in the settings strip, opens as a small floating panel. Controls: font size (slider), text color (color swatches), highlight color (color swatches), background opacity (slider), vertical position (slider, 0 = top, 100 = bottom), maximum lines (1 or 2 toggle), and time offset in milliseconds (slider with positive and negative values, with explicit labels "Earlier (negative) ←  → Later (positive)"). A "Reset to defaults" button at the bottom. Settings are saved to `localStorage` per video id automatically as the user changes them — no save button.

## Backend

### Schema

The viewer reads from `cached_transcripts` (the canonical transcript payload, keyed by video id and language) and indirectly from `api_requests` (to confirm the user has access to this video). It does not own any new tables. Translations on demand go through the standard translation service and write a new `cached_transcripts` row keyed by the target language so subsequent visits hit the cache.

### Endpoints

- **`GET /me/transcript?video_id=…&language=…&format=…`** — cookie-authed. Returns the cached transcript for the given video and language without spending credits. Used as the viewer's primary data source. If `language` is omitted, returns the most-recently-cached language for this video. If `format` is omitted, defaults to `json`. Returns the standard transcript envelope with segments, full text, video metadata (title, channel, thumbnail, duration), language, and source.

- **`GET /v1/transcript`** (existing public endpoint) — used only when the viewer needs to kick off a fresh fetch (e.g. user clicked "Translate to Spanish" and no cached Spanish row exists yet). Called from the browser using a stashed API key. Spends credits as normal.

- **`GET /me/transcripts/:videoId/languages`** (optional convenience endpoint) — returns the list of cached languages for this video so the language switcher knows what's available without making one request per language. If skipped, the frontend can derive this from the user's history list response.

### Logic

`/me/transcript` goes through the same orchestrator as the public endpoint but with two differences: no API key check (the session is sufficient) and no credit deduction. Cache lookup proceeds Redis first, Postgres second; on Postgres miss, the endpoint either returns 404 ("transcript no longer available, re-fetch needed") or transparently re-fetches and re-caches without charging — pick the simpler one (404 with a clear error code) so the frontend can show a "Re-fetch" CTA.

Translation requests from the viewer go through the standard `translate_to` parameter on the public API. The backend's translation service handles the tiered fallback (stub / Google free / OpenAI paid). The result is cached as a new row keyed by the target language so subsequent visits skip re-translation.

The "Format export" buttons can be served two ways: by re-calling the API with `format=srt` (etc.) and downloading the response, or by generating the format client-side from the cached JSON. Client-side is preferable because it's instant, offline-capable for the duration of the page session, and doesn't add a round-trip per export. The format converters are simple enough — JSON to SRT is "for each segment, emit index, then `start --> end` in HH:MM:SS,mmm form, then text, then blank line".

Edge cases:

- Video has been requested but no transcript was ever successfully cached for any language. Show a "No transcript available" panel with a "Try fetching again" button.
- User navigates directly to `/dashboard/transcripts/<videoId>` for a video they've never requested. Show a "Fetch transcript" CTA that posts to the public API using a stashed key, then reloads the viewer with the freshly-cached payload.
- YouTube IFrame Player API fails to load (ad blocker, network, regional restrictions). Detect the failure (the API exposes ready/error callbacks) and replace the player area with an inline "Couldn't load YouTube player" message. The right-pane reading view should still work fully — segments visible, search functional, export buttons working.
- Very long videos (1000+ segments). The segment list must be virtualised — render only the visible rows plus a small overscan, recycle DOM nodes as the user scrolls. Use `react-window` or equivalent. Without virtualisation a 90-minute lecture's segment list freezes the page on initial render.

## Frontend

The viewer page lives at `frontend/src/app/dashboard/transcripts/[videoId]/page.tsx`. It is a client component because the YouTube player API and high-frequency time polling are inherently browser-side.

**Mount sequence.** The page reads `videoId` from the route params and the optional `language` from the search params. It calls `api.me.transcript({ videoId, language })`. While loading, render a skeleton (player placeholder + skeleton segment rows). On 404, render the "Fetch transcript" CTA. On success, mount the player, render the segment list, and start the time-polling loop.

**Player wrapper.** A small `lib/youtube-player.ts` module that wraps the YouTube IFrame Player API: a `loadPlayer(containerRef, videoId)` function returning a player handle with `seekTo(seconds)`, `play()`, `pause()`, `getCurrentTime()`, and ready/error event handlers. The wrapper handles the API's odd loading semantics (the global `YT` object loaded lazily via a `<script>` tag, the `onYouTubeIframeAPIReady` callback) so the page doesn't have to.

**Time polling.** A `setInterval` at 250 ms (~4 Hz) calls `player.getCurrentTime()` and updates a `currentTimeMs` piece of state. The state drives both the segment-list active-row highlighting and the subtitle overlay's word selection. The interval is cleared on unmount and on player error.

**Active segment computation.** Given `currentTimeMs` and the segments array, find the segment whose `start <= currentTime < start + dur`. Memoise this computation so it only re-runs when `currentTimeMs` actually crosses a segment boundary, not on every tick.

**Autoscroll.** When the active segment index changes and the autoscroll toggle is on, scroll the segment list so the active row is centred in the visible viewport. Use `scrollIntoView({ block: 'center', behavior: 'smooth' })`. Disable autoscroll automatically for ~3 seconds after the user manually scrolls the list (so the scroll-to-active doesn't fight the user).

**Segment search.** The search input drives a `query` piece of state. The visible segments are derived as `segments.filter(s => s.text.toLowerCase().includes(query.toLowerCase()))`. Inside each visible row, wrap matched substrings in a `<mark>` for visual highlight. When a search query is active, autoscroll is implicitly disabled (the active segment may not be in the filtered list).

**Export buttons.** Four buttons that call client-side format converters in `lib/transcript-formatters.ts`: `toJson(segments)`, `toText(segments)`, `toSrt(segments)`, `toVtt(segments)`. Each returns a string. The button creates a Blob with the appropriate MIME type, generates an object URL, sets a hidden anchor's `download` attribute to a sensible filename (`<videoId>.<ext>`), clicks it, and revokes the object URL.

**Subtitle overlay component.** Lives at `components/dashboard/subtitle-overlay.tsx`. Takes the current segment, the elapsed time within that segment, and the user's settings. Splits the segment text on whitespace into words. Computes `wordIndex = floor((adjustedTime - segmentStart) / wordDuration)` where `wordDuration = segment.dur / wordCount` and `adjustedTime = currentTime - offsetMs/1000`. Renders all words inline; the word at `wordIndex` gets the highlight background. Position, font, color, max lines, and background opacity all come from the settings.

The overlay's outer container uses absolute positioning relative to the player wrapper, with `pointer-events: none` so clicks pass through. The settings popover (`components/dashboard/subtitle-settings-popover.tsx`) reads and writes the per-video settings via a `lib/subtitle-settings.ts` module that handles localStorage with a versioned key (bump the version when the settings shape changes so old persisted blobs are gracefully discarded).

**Subtitle offset slider — direction matters.** Positive offset means subtitles appear *later* (delayed), negative means earlier. This follows the SRT/VLC convention. Internal formula: `adjustedTime = currentTime - offsetMs/1000`. Documented prominently in the settings popover label and in code comments so future contributors don't accidentally invert it. This is item three on the project's "things that look like bugs but aren't" list.

**Word-by-word timing — uniform slicing.** YouTube's native captions don't include per-word timestamps. Whisper does, but we treat all sources uniformly here for simplicity. Splitting each segment's duration evenly across its word count is a known approximation that matches what every competitor player does. Don't try to "fix" this with phoneme analysis or speech alignment — it's not a bug.

**Language switcher.** If the user has multiple cached languages for this video (returned from history or from the languages endpoint), render a small dropdown next to the search input. Switching languages triggers a fresh `/me/transcript` call with the new language and replaces the segments. The current playback time is preserved across the switch.

**Translate-to dropdown.** A separate dropdown listing the ~45 supported languages. On selection it shows a small "Translating…" overlay on the segment list, calls the public API with `translate_to=…` using a stashed key, and on response replaces the segments in place. If no key is stashed, surface a small inline warning and link to API Keys.

## Dependencies

- `dashboard.md` — the viewer is a child page of the dashboard shell.
- `transcript-history.md` — the history page links here, and the new-transcript form redirects here.
- `playground.md` — the key-stash mechanism is shared. The viewer's translate and re-fetch paths read from it.

## Verification

- Open the viewer for a cached video. The player should load and play; the segment list should populate; clicking any segment should jump the player to that timestamp and start playback.
- Let the video play. The active segment in the right pane should highlight in time with the speech, and (with autoscroll on) the list should scroll to keep the active row visible.
- Toggle the subtitle overlay off and on. The on-player text should disappear and reappear without affecting playback.
- Open the settings popover, drag the offset slider to +1000 ms. The overlay text should now lag the speech by one second. Drag to -1000 ms — it should lead by one second. Reset to defaults. Reload the page — settings should persist.
- Type a substring of one segment's text into the search box. Non-matching segments should hide; matching ones should show the substring highlighted in yellow.
- Click each export button and confirm the downloaded file contains the expected format (an SRT file should have `index`, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, text, blank line; a VTT file should start with `WEBVTT`).
- Pick a translate-to language. The segments should be replaced with translated text within a few seconds. The current time should remain unchanged. The new language should now appear in the language switcher on subsequent loads.
- Throttle the network in DevTools and reload — the loading skeleton should be visible, not a blank page. Then block `youtube.com` in the network tab and reload — the player area should show the inline error, but the right pane should still work.
- Open a 90-minute video's viewer. Scroll the segment list rapidly. The page should remain responsive (virtualisation working). DOM node count should stay roughly constant, not grow into the thousands.
- One-line sanity check: `curl -b cookies.txt 'https://<backend>/me/transcript?video_id=<id>&language=en'` should return the same payload the viewer renders.
