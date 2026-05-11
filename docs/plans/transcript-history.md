# Transcript History

## What this is

Once a user has fetched even one transcript through the API, that transcript becomes part of their personal library inside the dashboard. The history page is the place where they go back to find a video they pulled last week, browse what their team has been processing, or jump straight into the in-browser viewer to read along with the video. This is the most "lived-in" surface of the dashboard — most repeat users will land here, not on the overview page.

History is not a separate storage system. Every successful fetch already writes two things: the transcript payload itself into a shared cache, and an audit row recording who asked for what and when. The history page is a join of those two: take all the audit rows belonging to this user, group them by video, and surface the matching cached transcript. If two different users both pull the same video, they each see it in their own history independently — the cache is shared, but the visibility list is per-user.

The point of the feature is to take a developer-facing API and give it a human-friendly memory. People can remember "I pulled that Andrej Karpathy talk last Tuesday" without remembering the URL, the format, or the language. They click in, get the viewer, and either re-export, translate, or read along with the video. Because the user has already paid credits for the original fetch, browsing their own history must never charge them again.

The page also doubles as the on-ramp for net-new fetches: a prominent "New transcript" button at the top of the list takes them to a small form where they paste a URL and pick a language, and the system kicks off a fresh fetch on their behalf using a stashed API key. New users land on an empty state with the same call to action front and centre.

## UI/interaction idea

The history page sits at `/dashboard/transcripts` and feels like a long, scannable inbox. The top of the page is a sticky header bar: a title on the left ("Your transcripts"), a search input in the middle that filters by title, channel name, or video id as the user types, and a primary "New transcript" button on the right.

Below the header are three filter chips: a language dropdown ("All languages" by default, expanding to the ~45 supported codes), a source dropdown ("All sources / Native captions / Whisper / Cache only"), and a clear-filters reset that only appears when something is selected.

The body is a table — but a roomy, modern one, not a dense spreadsheet. Each row has, from left to right: a 16:9 thumbnail pulled from `i.ytimg.com`, then a stack with the video title in bold and the channel name in muted text below, then a language badge (e.g. "EN", "BN"), a source badge ("native" in green, "whisper" in amber, "cache" in slate), the date of the most recent request in relative form ("3 days ago"), the total credits the user has spent on this video across all their fetches, and a "View" link on the right that takes them into the viewer.

Rows are clickable in their entirety, not just the View link. Hovering a row gives it a subtle background tint. Pagination sits at the bottom — 25 rows per page by default, with prev/next buttons and a "showing 26–50 of 318" counter.

The empty state replaces the entire table when the user has zero history: a friendly illustration, a one-line "Your transcript history will appear here", and a large "Fetch your first transcript" button leading to the new-transcript form.

The new-transcript form at `/dashboard/transcripts/new` is intentionally small: one URL input, one language picker (defaulting to "auto-detect"), one optional translate-to picker (defaulting to "don't translate"), and a submit button. After submit, a spinner with a one-line status message ("Fetching captions…", "Running Whisper…", "Translating to Spanish…") covers the form, and on success the page redirects to the viewer at `/dashboard/transcripts/<videoId>`.

## Backend

### Schema

No new tables — the page is composed entirely from existing ones. The `cached_transcripts` table holds the actual transcript payloads keyed by video id and language. The `api_requests` table holds one row per API call, including the requesting `user_id`, the resolved `video_id`, the format requested, the source the transcript came from (native vs whisper vs cache hit), the credits charged, the response status code, and the timestamp. The history view is just `cached_transcripts JOIN api_requests` filtered to the calling user.

A typical history row needs: video id, video title, channel name, thumbnail URL, language of the cached transcript, source it was originally pulled from, the timestamp of this user's most recent request, the count of times this user has requested this video, and the running sum of credits this user has spent on it.

### Endpoints

- **`GET /me/transcripts`** — cookie-authed. Returns a paginated list of the caller's transcript history. Supports `limit` (default 25, max 100), `offset`, `q` (substring match on title/channel/video id), `language` (filter to one ISO code), and `source` (one of `native`, `whisper`, `cache`). The response is an envelope with `items`, `total`, `limit`, and `offset`. Each item carries the fields described above. Items are ordered by most-recent-request descending.

- **`GET /me/transcript`** — cookie-authed. Takes `video_id` (required), `language` (optional, defaults to whatever language was originally cached), and `format` (optional, defaults to `json`). Returns the same payload shape as the public `/v1/transcript` endpoint — segments, full text, video metadata, source, language. Crucially, this endpoint does **not** charge credits and does **not** count against the user's rate limit, because the user has already paid for this video on the original fetch.

### Logic

The list endpoint's query is the trickiest piece: for each `(user_id, video_id)` pair, take the most recent request, count all requests, sum credits used, and join in the cached transcript's metadata (title, channel, thumbnail, language, source). Postgres handles this cleanly with a `DISTINCT ON (video_id)` plus an aggregate subquery joined on video id. Always filter to `status_code = 200` so failed fetches don't pollute history.

The single-fetch endpoint goes through the same orchestrator the public API uses, but with a "skip-credits" flag. Internally it still touches the cache (Redis first, Postgres second) — if the cache is somehow missing the row even though there's an audit entry, fall back to a fresh fetch and re-cache it, but still don't charge. This is rare but possible if the cached row has been manually purged.

Edge cases worth being explicit about. A user who has only ever made failed requests sees the empty state, not a list of errors. A user whose request succeeded but whose cached transcript was later evicted from Postgres (e.g. data hygiene job) gets a "transcript no longer available" placeholder row with a "Re-fetch" link. The search filter is case-insensitive and matches on a substring — no fuzzy matching, no full-text search. The language filter applies to the cached transcript's language, not to translations the user might have requested. Sorting is fixed at most-recent-first; alternative sorts are out of scope.

The `q` parameter must be properly parameterised in the SQL, not interpolated — title and channel are user-controlled strings.

## Frontend

The history list page (`/dashboard/transcripts`) is a client component. On mount it calls the typed API client (`api.me.listTranscripts({ limit, offset, q, language, source })`). It maintains four pieces of local state: the current page offset, the search query, the language filter, the source filter. Search input is debounced 300 ms before refetching. Filter changes refetch immediately and reset offset to zero.

Render states: while loading, show a skeleton table of eight grey rows. On error, show a destructive toast plus an inline "Couldn't load transcripts — try again" panel with a retry button. On success with zero results (and no filters active), show the empty state described above. On success with zero results but filters active, show a smaller "No transcripts match your filters" message with a "Clear filters" button.

The new-transcript form page (`/dashboard/transcripts/new`) is also a client component. It reads the user's most-recently-created plaintext API key from `localStorage` (the "key stash") and uses it to call the public `/v1/transcript` endpoint with `Authorization: Bearer …`. If no key is stashed (e.g. they cleared local storage or are on a fresh device), the form shows a one-line warning at the top — "You'll need an API key first" — with a button linking to `/dashboard/api-keys`. After a successful fetch, it routes to `/dashboard/transcripts/<videoId>`. After a failed fetch, it surfaces the API's typed error envelope (`{ error, code, message }`) inside a destructive alert banner above the form, with the form's inputs preserved so the user can retry.

Components live under `frontend/src/app/dashboard/transcripts/` for the pages, with shared row/empty-state pieces under `frontend/src/components/dashboard/`. The list table uses the shadcn `Table` primitive; badges use shadcn `Badge`; the filter dropdowns are shadcn `Select`.

## Dependencies

- `dashboard.md` — the dashboard shell and sidebar must exist for these pages to live inside.
- `transcript-viewer.md` — the "View" link assumes the viewer page exists at `/dashboard/transcripts/<videoId>`.

## Verification

- Sign up a fresh user, hit the public API with their key against three different YouTube URLs, then load `/dashboard/transcripts` and confirm three rows appear with correct titles, channels, languages, and "Just now" timestamps.
- Type a substring of one of the channel names into the search box; the list should narrow to matching rows within ~300 ms with no full-page reload.
- Pick a language filter that no row matches; the table area should show "No transcripts match your filters" and a working clear button.
- Click any row's "View" link; it should navigate to the viewer page for that video without triggering a billable fetch (confirm by checking the credit balance in the topbar before and after — it should be unchanged).
- As a second, separate user, fetch one of the same videos; load that user's history and confirm they see a row with their own first-request timestamp, not the first user's.
- Sanity curl while logged in: `curl -b cookies.txt https://<backend>/me/transcripts?limit=5` should return the same payload shape the dashboard renders.
