# Usage Analytics

## What this is

Customers paying real money for an API want to see what they're getting for it. They want to know how many requests they made this month, how many credits they have left, which videos they pulled, whether their pipeline is leaning on cached responses (cheap) or fresh Whisper runs (expensive), and whether yesterday's spike was a bug or genuine traffic. Usage analytics is the dashboard surface that answers all of those questions, backed by a per-request audit log on the server side.

The audit log records every successful API call — and most failed ones — into an `api_requests` table, with enough columns to slice the data multiple ways. The dashboard's usage page reads aggregations of that log: a summary card for the current month, a 30-day line chart, a breakdown by source, and a paginated table of the most recent calls. Customers can filter by date range and group by source or format. Everything is per-user, scoped to whoever owns the API key the request was made with.

The single most important behavioral rule is that writing the audit row must never block the response. The customer is paying for transcript latency, not for our analytics throughput. If the audit insert is slow or fails, the response goes out anyway and we tolerate the lost row. This is best-effort logging — high accuracy in normal operation, graceful degradation under load.

## UI/interaction idea

The usage page lives at `/dashboard/usage` and opens to a default view of the last 30 days. Top of the page is a row of four summary cards: total requests this month, credits used this month, credits remaining, and average latency. Below that is a Recharts line graph spanning the date range, with two overlaid series — requests per day and credits per day — and the dates on the x-axis. Hovering a point shows the exact numbers in a tooltip.

A small filter bar above the chart lets the customer pick a date range (a date-picker with quick buttons for "Last 7 days", "Last 30 days", "This month", "Custom") and a group-by toggle (None, Source, Format). When grouped by source, the line chart breaks into three colored series (native, whisper, cache) so the customer can see at a glance how much of their traffic is hitting cache.

Below the chart is the recent-requests table — the last 20 calls by default, sortable by any column, with pagination for older ones. Columns: timestamp, video ID (linked to the in-browser viewer), format, source, credit cost, status code, latency. A red-tinted row for any non-2xx response. Clicking a row expands it to show the full request URL, the API key name (not the secret) used, and any error message.

There is no export-to-CSV button in the MVP — call it out as future work. Customers who want raw data can hit `GET /me/usage` directly with their API key and parse the JSON themselves.

## Backend

### Schema

A new `api_requests` audit table:
- `id` — bigserial primary key.
- `user_id` — who made the request.
- `api_key_id` — which key was used, so a customer with multiple keys can attribute usage.
- `video_id` — the YouTube video ID, nullable for malformed requests.
- `format` — one of `json`, `text`, `srt`, `vtt`.
- `language` — the actual returned language (or null on failure).
- `translate_to` — the target translation language, nullable.
- `source` — `native`, `whisper`, `cache`, or null on failure.
- `credit_cost` — integer, the credits actually charged for this request (0 for cache, 0 for failed requests that got refunded).
- `status_code` — HTTP status returned to the customer.
- `latency_ms` — wall time from request received to response sent, in milliseconds.
- `error_code` — short string for non-2xx responses (`PAYMENT_REQUIRED`, `RATE_LIMITED`, `UPSTREAM_ERROR`, etc.), null on success.
- `created_at` — timestamp.

Indexes:
- `(user_id, created_at desc)` — the workhorse index for the dashboard's recent-requests query and date-range aggregations.
- `(user_id, source, created_at)` — for the group-by-source aggregations to stay fast.
- A BRIN index on `created_at` would be useful at scale but is optional at MVP volumes.

This table will grow forever. A retention policy (drop rows older than 12 months, or roll them up into daily summaries) is future work — for now we keep everything.

### Endpoints

- `GET /me/usage` — authenticated. Query parameters:
  - `from`, `to` — ISO date strings, defaulting to the last 30 days if omitted.
  - `groupBy` — optional, one of `source` or `format`. If absent, returns ungrouped totals.
  - `limit` — for the recent-requests slice, default 20, max 100.
  - `offset` — for paginating through the recent-requests slice.

Response is a single JSON object with these top-level fields:
  - `totals` — an object with `requests`, `creditsUsed`, `creditsRemaining`, `avgLatencyMs` for the date range.
  - `bySource` — an object keyed by `native`, `whisper`, `cache`, each value `{ count, credits }`.
  - `histogram` — an array of one object per day in the range, each `{ date, requests, credits }`. Days with zero activity are included as zero-valued rows so the chart x-axis is contiguous.
  - `recent` — an array of the most recent N requests, newest first, with all the columns listed in the schema above.
  - `pagination` — `{ limit, offset, total }` for the recent slice.

If `groupBy` is set, the `histogram` array's day objects also carry a per-group breakdown (e.g. `{ date, native: { requests, credits }, whisper: {...}, cache: {...} }`).

### Logic

**Asynchronous audit writes.** When a public API request finishes, the response is sent first, then a fire-and-forget call inserts the audit row. In Express terms this means the response is flushed and only after that does the handler call into the audit-log writer, which is wrapped to swallow its own errors and log them without bubbling. If the database is temporarily slow or down, requests still complete and we just lose those audit rows. We track the dropped count via a counter for ops visibility.

In practice this is implemented as a small in-memory queue or a simple `setImmediate` wrapper — nothing fancy at MVP scale. If we ever need stronger guarantees we can move audit writes to a real queue (BullMQ on the existing Redis), but for now best-effort is correct.

**Cache-hit accounting.** A cache hit produces an audit row with `source: cache`, `credit_cost: 0`, and a normal 200 status. The histogram counts these in the per-day request count (so a customer hammering cache sees their request volume accurately) but contributes zero to the credits-per-day figure. This is the "don't double-count" rule — cache hits are real requests but free requests, and the dashboard should show both truths simultaneously without conflating them.

**Failed requests.** A 402 (insufficient credits) writes an audit row with `credit_cost: 0`, `source: null`, `status_code: 402`, `error_code: PAYMENT_REQUIRED`. A 429 writes similarly with `RATE_LIMITED`. A 5xx writes with `UPSTREAM_ERROR` or similar. These rows show up in the recent-requests table (red-tinted) but are excluded from the bySource breakdown (since they have no source) and counted but not credit-weighted in the histogram. The dashboard's "requests this month" total includes failed ones because that matters for debugging; the "credits used" total naturally only sums successful work.

**Date range defaults.** If neither `from` nor `to` is given, the default is the last 30 calendar days ending today (in UTC — we don't try to per-user timezones in MVP, the dashboard renders dates in the browser's local timezone which is a reasonable approximation for most users). If only `from` is given, `to` defaults to today. If only `to` is given, `from` defaults to 30 days before `to`.

**Pagination on the recent slice.** The recent-requests table uses limit/offset because that's what shadcn/ui's `<Table>` plus a paginator natively supports. At very high volumes this gets slow on deep pages, but for the MVP target (a customer scrolling through their last few hundred requests) it's fine. If it bites we'll switch to keyset pagination on `(created_at, id)`.

**Aggregation queries.** All four aggregations (totals, bySource, histogram, recent) run as separate Postgres queries within the same handler call. We don't try to combine them into a single mega-query; they're each simple GROUP BYs and the handler returns them all together. The slowest of them is the histogram with `groupBy=source` because it triple-groups, but with the right indexes it's still sub-100ms at MVP scale.

**creditsRemaining.** Pulled from `users.credit_balance` directly, not aggregated from the log. This matches the "balance is source of truth, log is forensic" rule from the credits doc. The number on the usage page should always match the number in the dashboard top bar.

**Filtering by API key.** Out of scope for the MVP query parameters but the underlying schema (`api_key_id` column) supports it, so a future "filter by API key" dropdown is a one-line addition to the WHERE clause.

## Frontend

The `/dashboard/usage` page composes four sections from `GET /me/usage`:

1. The four summary cards at the top — these are dumb display components driven entirely by `response.totals`.
2. The Recharts line graph driven by `response.histogram`. Two overlaid lines (requests, credits) when not grouped, three or four lines when grouped by source/format. The x-axis is dates; the y-axis auto-scales. Tooltips on hover.
3. The recent-requests table from `response.recent`. Sortable client-side on the visible page; pagination triggers a refetch with the new `offset`. Each row clickable to expand for full detail.
4. The filter bar above everything (date range, group-by toggle), which on change refetches `/me/usage` with the new query params and rerenders all sections.

The dashboard top bar's "credits remaining" indicator (defined in the credits doc) reads from the same `creditsRemaining` field for consistency.

## Dependencies

Credits and rate limiting must exist — `credit_cost`, `creditsRemaining`, and the failure error codes all depend on that system. The cache strategy must exist for `source: cache` rows to be meaningful (without it everything would be `native` or `whisper`). Output formats provides the format enum used for the `format` column.

## Verification

Make 5 requests against a known video — the first hits the upstream, the next 4 are cache hits. After all 5 complete, `GET /me/usage` should show `totals.requests: 5`, `bySource.native.count: 1`, `bySource.cache.count: 4`, `totals.creditsUsed: 1`. The histogram should show today as `{ requests: 5, credits: 1 }`.

Force a 402 (drop credit balance to zero, request a fresh video). The usage response should include the 402 in `totals.requests` and in the `recent` array (with `error_code: PAYMENT_REQUIRED`, `status_code: 402`, `credit_cost: 0`), but `totals.creditsUsed` should be unchanged.

Set the date range to the last 7 days when there's data spanning 30 days — the histogram should have exactly 7 entries and the totals should reflect only the last week.

A `groupBy=source` request should return a histogram with per-source breakdowns on each day object, and the dashboard line chart should render three colored lines.

Kill Postgres temporarily and make 10 API requests against an in-memory cached video. All 10 should succeed (cache hits), the customer's response should be normal, and a counter should show ~10 audit-write failures. Bring Postgres back up; subsequent requests should resume logging without manual intervention.

`curl "https://api.example.com/me/usage?from=2026-04-01&to=2026-04-30" -H "Authorization: Bearer $KEY"` should return the structured JSON described above with one histogram entry per April day.
