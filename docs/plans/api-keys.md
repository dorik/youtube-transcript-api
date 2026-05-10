# API Keys

## What this is

API keys are how customers authenticate against the public REST API. After signing up and logging into the dashboard, a user creates a key, copies it once, and uses it as a Bearer token in `Authorization` headers for every `/v1/*` request. A user can have multiple keys (typically one per environment — production, staging, local), label them, and revoke them independently. This doc covers both halves of the system: the dashboard-facing CRUD that lets users manage keys, and the Bearer middleware that authenticates every public API call against those keys.

A key looks like `yt_live_<24-byte base64url>` — about 38 characters total. The `yt_live_` prefix is human-recognizable in logs and codebases (so a leaked key is obvious in a repo scan). The 24 random bytes provide enough entropy that brute-forcing one is not a realistic concern.

The most important rule: **plaintext is shown exactly once**, at the moment of creation, and never again. The database stores only a sha256 hash. Users who lose a key must rotate — there is no "show me my key again" flow, by design.

## UI/interaction idea

The API keys page in the dashboard is a single screen with a list and a "Create key" button at the top right. The list is a table with columns: name, prefix (something like `yt_live_aB3xQ9k…`), created, last used, status. Each row has a kebab menu with "Revoke" as the only action. Revoked keys stay in the list with a muted "Revoked" badge so users can see the history; a small "Hide revoked" toggle filters them out.

Creating a key opens a small dialog with one input — the key's name. Submit, and the dialog content swaps to a "Your new key" view: the plaintext token in a read-only field, a copy button, and a prominent warning ("This is the only time you'll see this key. Save it somewhere safe."). The dialog cannot be dismissed by clicking outside; only an explicit "I've saved it" button closes it. After it closes, the list refreshes and the new row appears with its prefix shown.

Revoking from the kebab menu opens a confirm dialog ("Revoke 'Production'? This cannot be undone and any code using this key will stop working immediately."). Confirm, and the row updates to show the Revoked status without leaving the page.

## Backend

### Schema

Uses the `api_keys` table from `database-schema.md`. Repeating the relevant columns in prose:

- `id` — UUID primary key.
- `user_id` — FK to the owning user; cascade on delete.
- `key_hash` — sha256 of the plaintext, hex-encoded; uniquely indexed for fast Bearer lookup.
- `key_prefix` — the first eight characters of the random suffix (the part after `yt_live_`); shown in the dashboard to identify the key.
- `name` — user-supplied label.
- `created_at` — when the key was issued.
- `last_used_at` — set fire-and-forget on every successful Bearer auth.
- `is_revoked`, `revoked_at` — revocation flags; once set, the key fails auth.
- `expires_at` — optional self-expiry; null means never.

### Endpoints

There are two surfaces. The dashboard CRUD routes are session-authed (cookie). The Bearer middleware itself is not an endpoint — it's middleware applied to every public API route.

Dashboard routes (cookie-authed, scoped to the calling user):

- `GET /me/api-keys` — returns the caller's keys as a list of `{ id, name, prefix, created_at, last_used_at, is_revoked, revoked_at, expires_at }`. Plaintext is never returned here. By default returns all keys including revoked; the frontend filters in JS based on the toggle.
- `POST /me/api-keys` — body `{ name }`. Generates a fresh 24-byte random token, computes the sha256 hash, stores the row, and returns `{ id, name, prefix, created_at, key }` where `key` is the plaintext. This is the only response in the entire system that includes a plaintext key. The frontend shows it in the post-creation dialog.
- `DELETE /me/api-keys/:id` — sets `is_revoked = true` and `revoked_at = now()` on the row, but only if it belongs to the calling user. Returns 204 on success, 404 if the key doesn't exist or isn't owned by the caller.

The Bearer middleware (applied to every `/v1/*` route):

- Reads the `Authorization` header. If missing or not `Bearer …`, returns 401 with code `MISSING_TOKEN`.
- Extracts the token, sha256-hashes it, looks it up in `api_keys` by `key_hash`. Single indexed query.
- If not found, returns 401 with code `INVALID_TOKEN`. The same code is used whether the row didn't exist or the user is suspended — we don't want to leak which.
- If `is_revoked` is true, returns 401 with code `KEY_REVOKED`.
- If `expires_at` is set and in the past, returns 401 with code `KEY_EXPIRED`.
- Loads the owning user. If `is_suspended` is true, returns 403 with code `ACCOUNT_SUSPENDED`.
- Attaches `{ user, apiKey }` to the request object for downstream handlers.
- Schedules an UPDATE of `last_used_at` to `now()` for the row, but does NOT await it — see the next section.

### Logic

**Token generation.** A new key is 24 cryptographically random bytes, encoded as base64url (no padding), prepended with `yt_live_`. That gives roughly 32 characters of randomness after the prefix, total length around 38. The randomness source is the platform's CSPRNG — never `Math.random`. The `yt_live_` prefix is constant; if we ever introduce test keys, they'd carry `yt_test_` to make them distinguishable in logs.

**Hashing.** sha256 is sufficient because the plaintext is already high-entropy and uniformly random. There's no benefit to bcrypt here — bcrypt's value comes from making low-entropy human passwords slow to brute-force, but a 24-byte random token cannot be brute-forced regardless of hash speed. sha256 is also fast and constant-time-comparable, which matters for per-request lookup latency.

**Prefix display.** The `key_prefix` is the first eight characters of the random suffix (so users see something like `aB3xQ9k7…` after the `yt_live_` part). Eight characters is enough for a user to identify which of their keys is which, but not enough for an attacker to use as a starting point for guessing the rest. The full prefix shown in the UI is `yt_live_` + the eight chars + an ellipsis.

**One-shot plaintext.** The plaintext is returned in exactly one place: the response of `POST /me/api-keys`. It is never logged, never echoed in `GET`, and never recoverable. If a user closes the creation dialog without copying the key, their only remedy is to revoke it and create a new one. The frontend dialog enforces this with the "I've saved it" button being the only way out.

**Revocation is immediate.** Because the Bearer middleware queries the database on every request (no in-memory cache of valid keys), revocation takes effect on the next request. There's no propagation delay. This is a small performance cost we accept — the alternative (a Redis cache of valid keys) would either be eventually-consistent or require careful invalidation, and the per-request cost of one indexed Postgres query is small.

**`last_used_at` is fire-and-forget.** Every successful Bearer auth would otherwise add a write to the hot path. To avoid that latency, the UPDATE is scheduled (e.g. via `setImmediate` or a small in-process queue) and the request proceeds without waiting. If the write fails, we log it but don't surface to the user. Worst case: the displayed "last used" is stale by a few seconds, or in extreme cases is missing entirely. That's fine — `last_used_at` is informational, not security-critical.

**Authorization on delete.** The DELETE route must check that the key being revoked belongs to the calling user, not just that the id exists. A bug here would let any logged-in user revoke any other user's keys. The check is one extra `WHERE user_id = $userId` clause; do not omit it.

**Multi-key support.** A user can have arbitrarily many keys. There's no soft cap in MVP, but we'd add one (say, 25 active keys per user) if abuse appeared. Revoked keys don't count against any cap because they can't be used.

**No expiry by default.** Most keys are created with `expires_at = null` and live forever (until revoked). A future feature could let users set an expiry at creation time — the column already exists. The middleware respects expiry today; only the UI is missing.

## Frontend

The API keys page is mounted at `/dashboard/api-keys` as a client component. On mount, it calls `GET /me/api-keys` and renders the list. A `useState` holds the "show revoked" toggle; the filter is purely client-side.

The "Create key" dialog uses the shadcn dialog primitive. Two states: the form (name input + Create button) and the post-creation success view (plaintext token in a read-only field, copy-to-clipboard button, "I've saved it" close button). The dialog cannot be closed by clicking the backdrop or pressing Escape during the success view — `onOpenChange` only allows close when the user clicks the explicit button.

The revoke confirm uses a smaller alert-dialog primitive with a destructive-styled confirm button.

After any mutation (create or revoke), the list is refetched. Optimistic updates are not used here — the round-trip is fast enough and the consequences of getting it wrong (a stale list showing a key as still active) are not worth the complexity.

## Dependencies

- `database-schema.md` — the `api_keys` table.
- `user-accounts-and-sessions.md` — the dashboard CRUD endpoints are cookie-authed and require a logged-in user.
- The dashboard shell (separate doc) provides the layout and navigation.
- Every public API endpoint (starting with `transcript-endpoint.md`) depends on the Bearer middleware described here.

## Verification

End-to-end checks:

1. Log into the dashboard, navigate to API keys, create one named "Test." Confirm the plaintext is shown in the dialog. Copy it. Close the dialog. Confirm the new row appears in the list with a sensible prefix and "Never used" for last used.
2. Reload the page. Confirm the plaintext is NOT shown anywhere — only the prefix.
3. From a terminal, hit the public API with the copied key:
   `curl -H "Authorization: Bearer yt_live_…" https://api.example.com/v1/transcript?url=…`
   Confirm a 200 response (or whatever the transcript flow would normally return for that URL).
4. Reload the dashboard. Confirm `last_used_at` updated to within the last few seconds.
5. Revoke the key from the kebab menu. Confirm the row updates to "Revoked" without a page reload.
6. Hit the public API again with the same key. Confirm 401 with code `KEY_REVOKED`.
7. Hit the public API with a syntactically valid but unknown key (e.g. `yt_live_aaaaaaaa…`). Confirm 401 with code `INVALID_TOKEN`.
8. Manually set `is_suspended = true` on the user, then hit the public API with one of their valid keys. Confirm 403 with code `ACCOUNT_SUSPENDED`. Reset suspension afterward.
9. Manually set `expires_at` to a past timestamp on a key, hit the API, confirm 401 with code `KEY_EXPIRED`.
10. From a second logged-in user, attempt to DELETE the first user's key by id. Confirm 404, not 204.

If all ten pass, the API key system is working as specified.
