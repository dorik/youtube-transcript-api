# Transcript row language tag — design

**Date:** 2026-05-17
**Status:** Approved

## Problem

Requesting the same video for two translation targets (e.g. one `translate_to: en`,
one `translate_to: bn`) produces two `transcript_requests` rows. The transcripts
list renders them with identical thumbnail, title, channel, and status — nothing
distinguishes them. Users see two seemingly duplicate rows and are confused.

## Change

Single file: `frontend/src/components/transcripts/TranscriptRequestRow.tsx`.

In the existing badge row — the `<div>` that already holds `RequestStatusBadge` —
render a second badge immediately after the status badge when
`request.request.translate_to` is set:

- **Label:** the ISO code uppercased — `EN`, `BN`.
- **Variant:** `outline`, so it reads as a distinct attribute next to the solid
  status badge.
- **Hover title:** the full language name via `languageLabel(code)` from
  `@/lib/languages` — a bare code is cryptic, so hovering `BN` shows "Bengali".
- **Untranslated requests** (`translate_to` empty/undefined) get **no tag** — the
  request is just the original transcript and needs no extra label.

The translation target is read into a plain `const` above the JSX `return`
(per frontend CLAUDE.md §7.5 — no derived values computed inline in JSX).

## Why this approach

- Reuses the existing `Badge` primitive and the `languages.ts` helper — no new
  component, no new dependency.
- The `TranscriptRequestRow` component is shared by the dashboard list and the
  playground, so dashboard and playground rows both get the tag for free.

## Rejected alternatives

- **Code in the muted `channel · videoID` line** — blends into muted text, easy
  to miss, does not read as a distinct attribute.
- **Corner overlay on the thumbnail** — crowds the thumbnail, which already
  carries the duration chip.

## Verification

- `cd frontend && npm run type-check` — zero errors.
- `cd frontend && npm run lint` — zero warnings.
- Manual: a row with `translate_to` shows the uppercased code badge; a row
  without it shows only the status badge.
