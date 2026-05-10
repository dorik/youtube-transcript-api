# Dashboard

## What this is

The dashboard is the post-login workspace where users actually run the product: where they create and revoke API keys, watch their usage trend over time, manage billing, and navigate into their transcript history and viewer. It's also the only authenticated surface in the app — every page under `/dashboard` requires a valid session cookie, and any unauthenticated visit redirects to login with a `next` parameter so the user lands back where they came from.

This document covers the dashboard shell (the layout that wraps every dashboard page) and the four "core" pages: Overview, API Keys, Usage, and Billing. Two more pages — Transcripts (history) and the Transcript Viewer — live under the same shell but have their own dedicated docs because they're substantially deeper than the rest.

The shell is intentionally thin. There's a left sidebar with five navigation items, a topbar that shows the current plan and credit balance, and a content area where the active page renders. There's no per-page server-side data fetching — every page is a client component that calls the typed API client and shows the appropriate loading/error/empty/success state. This is a deliberate choice driven by production cookie behaviour, explained below.

The big architectural pin: the dashboard layout itself **must** be a client component. In production the frontend lives on Vercel and the backend on Render — two different domains. The session cookie is set by the backend with `SameSite=None; Secure`, and that cookie is sent to the backend by the browser on cross-domain fetches when `credentials: 'include'` is used. But it is **not** visible to Vercel's server during SSR — Vercel's server is on a different domain and sees no cookies for the backend. So a server-side `cookies()` call in the dashboard layout would always conclude "no session, redirect to login", even for fully-authenticated users. The fix is to do the auth check in the browser: the layout mounts, fetches `/auth/me` with credentials, and on 401 redirects to `/login?next=…`. On success it hands `req.user` down via React context.

## UI/interaction idea

**The shell.** A two-column layout. The left column is a 240-pixel-wide sidebar with the product wordmark at the top and a vertical list of navigation items: Overview, Transcripts, API Keys, Usage, Billing, and a Logout button pinned at the bottom. The active item gets a subtle accent background and a left-edge accent bar. On screens narrower than 1024 pixels the sidebar collapses behind a hamburger that opens it as a slide-in sheet.

The right column has a topbar across the top: workspace/account name on the left, then a small plan badge ("Free", "Starter", "Pro", "Business") with the current plan's accent color, then a credit balance counter ("142 credits"), then a user avatar/menu on the far right that opens a dropdown with the user's email and a "Sign out" item. Everything below the topbar is the page content area.

While the layout is checking the session for the first time, the entire content area shows a centered spinner — not a skeleton, because we don't yet know what page is going to render. After auth resolves, the page mounts and shows its own loading state.

**Overview page (`/dashboard`).** A grid of four stats cards across the top: "Credits remaining" (big number, percentage-of-monthly-quota subtext), "Requests this month" (big number, comparison to last month as a small "+12%" chip), "Transcripts cached" (count of unique videos in this user's history), and "Current plan" (plan name with an "Upgrade" link if not Business). Below the cards, a "Recent activity" panel that's a compact table of the last ten requests — timestamp, video id, format, source, status — pulling from the same data source the Usage page's table uses.

**API Keys page (`/dashboard/api-keys`).** A page header with the title and a "Create API key" primary button on the right. Below, a table of existing keys: name, prefix (e.g. `yt_live_AbCd…`), creation date, last-used timestamp, and a destructive "Revoke" action per row that opens a confirmation dialog. Clicking "Create API key" opens a dialog with one input (key name) and a "Create" button. On submit, the dialog's body changes to show the freshly-minted plaintext key in a copy-friendly box, with a bright warning ("Copy this key now — you will not be able to see it again"), a "Copy" button, and a single "Done" button to dismiss. The dismiss action also stashes the plaintext into `localStorage` so the playground and the new-transcript form can pre-select it later.

**Usage page (`/dashboard/usage`).** Top of page: a 30-day line chart (using `recharts`) of "Requests per day" with the current month plotted, hover tooltips showing the day's count. Below the chart: a sortable, paginated table of recent requests with columns timestamp, video id, format, source ("native" / "whisper" / "cache"), credit cost, response status code, and latency in ms. The table supports sort by timestamp (default), latency, and credit cost, and paginates 25 rows at a time. A small filter bar above the table lets the user filter by status (success / error) and by source.

**Billing page (`/dashboard/billing`).** A "Current plan" card at the top showing the plan name, the monthly price, the credit allotment, and the renewal date. To the right of that card, an "Upgrade" panel with a button per higher-tier plan that, when clicked, calls `/billing/checkout?plan=…` and redirects the user to Stripe Checkout. In stub mode (when Stripe isn't configured), the page accepts a `?stub_success=1&plan=…` query string on return — when those params are present, the page calls `/billing/stub-activate` and shows a "Plan activated!" success toast. Below those cards, a "Recent invoices" section listing the last few invoices with date, amount, and a "View" link going to the Stripe Customer Portal.

## Backend

### Schema

The dashboard reads from existing tables — it does not own any new ones. Specifically: `users` (account info, current plan, credit balance), `api_keys` (one row per key with prefix, name, hash, created_at, last_used_at, revoked_at), `api_requests` (one row per call, used by Overview's recent activity and Usage's chart and table), and the billing-related tables (`subscriptions`, `invoices`).

### Endpoints

All dashboard endpoints are cookie-authed via the session middleware.

- **`GET /auth/me`** — returns the current user's id, email, plan, credit balance, and account creation date. Used by the dashboard layout for the auth gate and by the topbar for plan badge and credit counter.
- **`GET /me/api-keys`** — returns a list of the caller's API keys with prefix, name, created_at, last_used_at, and a `revoked` flag. Hashes are never returned.
- **`POST /me/api-keys`** — body is `{ name }`. Returns the freshly-minted plaintext key (only time it's ever sent), plus its prefix, name, and id.
- **`DELETE /me/api-keys/:id`** — marks the key as revoked. Returns 204 on success.
- **`GET /me/usage`** — returns aggregate stats and a recent-requests list. Supports `range=30d|7d|24h` and pagination params for the table. Response includes per-day counts for the chart and an `items` array for the table.
- **`GET /plans`** — public. Returns the list of available plans with prices and features. Used by the upgrade panel.
- **`GET /me/subscription`** — returns the caller's current subscription state.
- **`POST /billing/checkout`** — body is `{ plan }`. Returns a Stripe Checkout URL the frontend should redirect to. In stub mode it returns a frontend URL with `?stub_success=1&plan=…` instead.
- **`POST /billing/stub-activate`** — body is `{ plan }`. Stub-only path that flips the user's plan and credits in place. Returns the updated subscription.

### Logic

The session middleware reads the `yt_session` httpOnly cookie, verifies the JWT, and sets `req.user`. On an invalid or missing cookie it returns 401 with a typed `{ error, code: 'UNAUTHORIZED', message }` envelope — the frontend layout uses the 401 to trigger its redirect-to-login.

API key creation generates a `yt_live_<24-char base64url>` token, sha256-hashes it, stores the hash plus a 12-character prefix for display, and returns the plaintext **once and only once** in the create response. The plaintext is never logged, never persisted unhashed, and never re-derivable. Revocation is a soft delete (set `revoked_at`); the row stays so historical `api_requests` audit rows still resolve their key reference.

Usage stats compute per-day request counts in Postgres with a `date_trunc('day', created_at)` group-by, filtered to the user. The table is straightforward: `SELECT … FROM api_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT … OFFSET …`. Both queries must use parameterised filters and a sensible default range (30 days) to avoid full-table scans.

Billing in stub mode is a development convenience — it lets the dashboard's Upgrade flow be exercised end-to-end without configuring Stripe. The frontend treats Stripe and stub modes identically from a UX standpoint; the difference is invisible. In production with Stripe live, the success path is Stripe Customer Portal redirect plus webhook-driven plan updates.

Edge cases. A user with zero API requests must still see the Overview page render cleanly with "0" stat cards and an empty recent-activity table — not a spinner that never resolves. A user with a single key must not be able to revoke it without explicit confirmation (the dialog should warn that they'll lose API access). The credit counter in the topbar should refresh after any action that spends or grants credits — easiest by re-fetching `/auth/me` after such actions.

## Frontend

The dashboard pages live under `frontend/src/app/dashboard/` with one file per route: `layout.tsx`, `page.tsx` (overview), `api-keys/page.tsx`, `usage/page.tsx`, `billing/page.tsx`, plus the transcripts subtree covered in the history and viewer docs.

`layout.tsx` is the auth-gated client component. On mount it calls `api.auth.me()`. While the call is in flight it shows a centered spinner. On success it stores the user in a `UserContext` provider that wraps the rest of the layout. On a 401 it calls `router.replace('/login?next=' + encodeURIComponent(currentPath))`. On other errors it shows a small "Couldn't load your account" panel with a retry button. The sidebar and topbar consume `useUser()` to render the email, plan badge, and credit counter.

Every page calls the typed API client (`lib/api.ts`). There are no inline `fetch()` calls anywhere in the dashboard. The api client centralises three concerns: it always sets `credentials: 'include'`, it always adds the correct base URL from `NEXT_PUBLIC_API_URL`, and it always converts non-2xx responses into a typed error object the pages can switch on.

Standard render states for every page:

- **Loading** — skeleton table or skeleton card (use `Skeleton` from shadcn). Don't render an empty page that fills in later; that causes layout shift.
- **Mutating** — a small inline spinner inside the action button, plus disabling the button so it can't be double-clicked.
- **Empty** — a friendly message with a CTA pointing the user toward whatever action makes the page non-empty (e.g. "You haven't created any API keys yet. Create one to start fetching transcripts.").
- **Error** — a destructive shadcn `Toast` plus an inline panel with an "Try again" button. The panel preserves any in-flight form state.

Dialogs (create-key, confirm-revoke, etc.) use shadcn `Dialog`. Toasts use shadcn `Toaster` mounted in the root layout.

Charts are `recharts` — kept simple: `LineChart` for the usage trend, no responsive container nesting weirdness, with the x-axis as ISO date strings and the y-axis as request counts.

The "Create API key" dialog also writes the plaintext key into `localStorage` under a key-stash entry (an array of objects with `id`, `prefix`, `plaintext`, `createdAt`). The playground and the new-transcript form read from this stash so the user can use a freshly-created key without copy-pasting.

## Dependencies

- `marketing-site.md` — login/signup are part of the auth flow; the dashboard layout's redirect target (`/login`) must exist.
- `transcript-history.md` and `transcript-viewer.md` — the sidebar's "Transcripts" item links to those pages.
- `playground.md` — the "Create API key" stash is consumed there.
- `deployment.md` — the cookie/CORS/SameSite configuration and the client-side auth pattern are all production-critical and detailed there.

## Verification

- With no session cookie, visit `/dashboard`. You should be redirected to `/login?next=/dashboard` after a brief spinner. After logging in you should land back on `/dashboard`, not on `/login`.
- The topbar credit counter should match what `/auth/me` returns. Make a transcript request from another tab, refresh the dashboard, and confirm the counter has decreased.
- Create an API key. The dialog should display the plaintext exactly once. Dismiss it, refresh the page, and confirm the table now shows the new key but only by prefix.
- Revoke a key. After confirmation, the row should disappear (or show a "revoked" badge) and a subsequent request using that key should return 401.
- On the Usage page, the chart should render with up to 30 data points, the table should paginate at 25 rows, and the sort headers should toggle ascending/descending.
- On Billing in stub mode, click "Upgrade to Pro" — the page should redirect, return with `?stub_success=1&plan=pro`, show a success toast, and reflect the new plan in both the Billing card and the topbar badge.
- Watch the Network tab during all of the above: every backend call should include the cookie and complete with `200` (or a typed error envelope on intentional failures). No call should be missing `credentials: 'include'`.
- One-line sanity: `curl -b cookies.txt https://<backend>/auth/me` should return the same user the dashboard renders.
