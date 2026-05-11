# Output Formats

## What this is

The YouTube Transcripts API returns transcripts in four shapes — JSON, plain text, SRT, and VTT — so that whatever the customer is building (a database row, a blog post, a video player overlay, a translation pipeline) they can grab the format that drops straight into their workflow without writing a parser.

The choice is made through a single `?format=` query parameter on the public endpoint. The default is JSON because it carries the richest payload (segment timings, language, source, metadata), and the other three are convenience wrappers around the same underlying segment array. Internally the system fetches or pulls-from-cache exactly one canonical representation — an ordered list of segments, each with a start time in seconds, a duration in seconds, and a text string — and then serializes that into whichever format was asked for at the very last step. Caching, credit accounting, translation, and language detection all happen on the canonical shape; format selection is a thin presentation layer on top.

This matters because it means a customer can request the same video twice, once as JSON and once as SRT, and the second call is a free cache hit — there is no "cache by format" multiplication. It also means new formats can be added later (DOCX, TTML, plain markdown) without touching the fetch or storage layers.

The dashboard mirrors the API. On the in-browser viewer page each transcript can be downloaded with a one-click chooser that emits the same four formats; the download endpoint is the same public endpoint with the customer's API key attached server-side, so the dashboard never has its own private serializer.

## UI/interaction idea

On the dashboard's transcript viewer there is a small dropdown above the transcript pane labeled "Download as" with four options: JSON, Text, SRT, VTT. Picking one triggers a download of a file named `<videoId>.<ext>` with the right MIME type so the OS picks the right default app — opening an `.srt` should land in VLC or a subtitle editor, opening a `.vtt` should be recognized by browsers, opening `.json` should land in a code editor, opening `.txt` should land in any text app.

There is also a "Copy to clipboard" button right next to the dropdown for quick paste into a doc or chat. Plain text is the most common copy target, so it is the default for the copy button.

## Backend

### Schema

No schema changes are needed for output formats. The canonical segment array is whatever the upstream returned (or whatever Whisper produced) and is stored as a JSON column on the `cached_transcripts` table. Format conversion is pure transformation at response time.

### Endpoints

- `GET /v1/transcript?url=<youtube-url>&format=<json|text|srt|vtt>&lang=<code>` is the single public endpoint. `format` defaults to `json` if omitted. `lang` is independent of format and defaults to `auto`.
- The dashboard download button hits the same endpoint with the customer's API key attached on the server side; there is no separate "download" route.

### Logic

The four serializers all consume the same canonical shape — an ordered list of `{ start, dur, text }` objects where `start` and `dur` are seconds (floats are allowed) — and produce a string plus a content-type.

JSON returns the full payload: a top-level object with `videoId`, `title`, `language` (the actual returned language code, e.g. `bn`, never `auto`), `source` (one of `native`, `whisper`, `cache`), `durationSeconds`, and `segments` (the array). Content-type `application/json`. This is the only format that surfaces metadata; the other three are caption-only.

Plain text concatenates the `text` fields of each segment with a single newline between them. We pick newlines (not spaces) because most downstream uses — pasting into a doc, feeding into an LLM, indexing into a search engine — read better with one segment per line, and a customer who wants a flowing paragraph can do `replace("\n", " ")` themselves. Embedded newlines inside a segment's text are preserved as-is. Content-type `text/plain; charset=utf-8`.

SRT (SubRip) emits sequentially numbered cues. Each cue is the index on its own line, then the timecode line `HH:MM:SS,mmm --> HH:MM:SS,mmm` (note the comma as the millisecond separator — that is the SRT convention and players will reject a dot here), then the text on the next line(s), then a blank line. The end timecode is computed as `start + dur`. If two consecutive segments overlap (segment N ends after segment N+1 starts, which happens occasionally with auto-generated captions) the end of segment N is clamped to the start of segment N+1 so cues never visually collide. Content-type `application/x-subrip`.

VTT (WebVTT) is similar to SRT but starts with the literal header line `WEBVTT` followed by a blank line, uses a dot for the millisecond separator (`HH:MM:SS.mmm`), and does not require a sequential index per cue (we omit it for cleanliness). Same overlap-clamping rule as SRT. Content-type `text/vtt`.

Edge cases the serializers must handle without crashing:
- An empty segment array — return an empty body for text/srt/vtt and a JSON payload with `segments: []` for JSON. Still a 200, not a 404; the video might genuinely have no captions.
- A segment whose `text` contains an embedded newline — preserved in JSON and text, and in SRT/VTT it becomes a multi-line cue (which the formats both natively support; a cue can span as many text lines as needed before the blank-line terminator).
- A segment whose `text` is empty or whitespace-only — emit it anyway with a blank cue body so the timing is preserved; subtitle players handle empty cues fine.
- Negative or zero duration — clamp to a 1ms minimum so the start/end timecodes don't equal each other (some players reject zero-length cues).
- Very long videos producing 5000+ segments — no special handling, the serializers stream the string in memory. If we ever need true streaming we'll revisit, but at typical YouTube lengths the payload is well under 1 MB.

The format query parameter is validated against the four-value enum before any work is done; an unknown format returns 400 with `INVALID_FORMAT` and lists the accepted values. The `Content-Type` and `Content-Disposition` headers are set per format — the latter as `attachment; filename="<videoId>.<ext>"` only when the request comes through the dashboard download flow (signaled by an internal flag), not on raw API calls, so direct API consumers can stream into their own pipelines without a forced download.

## Frontend

The transcript viewer page in the dashboard owns the format chooser. It is a shadcn dropdown with the four options, plus a "Copy" button next to it. Selecting an option fires the download by setting `window.location` to the public endpoint with the format and the user's API key (passed via a short-lived signed token, not the raw key, so the key never lands in browser history).

The viewer itself always renders from the JSON shape — the segment array drives the scrolling caption list and the click-to-seek behavior in the embedded player. The other three formats exist purely as exports.

The pricing page and API docs page list all four formats with a one-line description and a sample of each (rendered from a real fixture, not mocked) so a prospective customer can eyeball whether SRT or VTT matches what their tooling expects.

## Dependencies

None. Output formats are a presentation layer on top of the canonical segment array and can ship before billing, translation, or analytics.

## Verification

A known YouTube video with native English captions should:
- Return a JSON payload whose `segments` array length matches the upstream count and whose `language` field is `en`.
- Return a plain-text body that is the same length (line count) as the segment array.
- Return an SRT body that parses cleanly in VLC and ffmpeg without warnings.
- Return a VTT body that loads as a `<track>` element on a sample HTML page and renders captions at the right times.

A one-line `curl` check for each format should produce the right `Content-Type` header — for example `curl -I "https://api.example.com/v1/transcript?url=...&format=srt"` should show `Content-Type: application/x-subrip`.

A video with no native captions (forcing the Whisper path in dev with `STUB_WHISPER=true`) should produce a stub-flavored transcript in all four formats with the same segment count, proving the serializers don't care about the source.

A video with overlapping segments (we keep one in the test fixtures) should produce SRT and VTT where no cue's end time is greater than the next cue's start time.
