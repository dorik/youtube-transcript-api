# User Accounts and Sessions

## What this is

Anyone using the dashboard, the playground, or the billing pages needs an account. This feature is the front door: signup with email and password, login that issues a session, a way for the frontend to ask "who am I right now," a token-refresh flow that keeps the session alive transparently, and logout that invalidates the session. It is intentionally minimal in surface area — no email verification, no password reset, no social login — because the MVP audience is developers who want to get to an API key in under thirty seconds, and ceremony gets in the way.

The session is built on **two tokens**, not one: a short-lived access token and a long-lived refresh token. The access token is what authorizes individual dashboard API calls; it is short-lived on purpose so that compromise has a small blast radius. The refresh token is long-lived but useless on its own — its only ability is to mint a new access token at the refresh endpoint, and using it rotates it (the old one is invalidated). This means we can revoke a session server-side at any time by deleting its refresh-token row, the dashboard never has to log a user out for "session expiry" under normal use, and an attacker who steals an access token has minutes, not days, to abuse it.

This system is the only auth scheme the dashboard uses. The public REST API uses a completely separate scheme — Bearer API keys — described in `api-keys.md`. The two never overlap; access tokens cannot call `/v1/*`, API keys cannot call `/me/*`.

## UI/interaction idea

There are exactly two screens in this feature: a signup page and a login page. They look almost identical: centered card on a neutral background, a single email input, a single password input, a primary button, and a small link at the bottom switching to the other mode. Errors render inline under the failing field — "email already in use," "incorrect password," "your account has been suspended" — never as toasts.

After successful signup or login, the user is redirected to `/dashboard`. If they were trying to reach a protected page beforehand, that destination is preserved in a `?next=` query param and used as the redirect target. If the redirect target is missing or unsafe, `/dashboard` is the fallback.

A small "Logout" item lives in the dashboard's user menu. Clicking it hits the logout endpoint, which revokes the refresh token server-side and clears both cookies, then redirects to `/login`.

The user never sees the refresh flow. When the access token expires mid-page, the next dashboard API call gets a 401 with code `TOKEN_EXPIRED`, the frontend silently calls `/auth/refresh`, and the original request is retried. If the refresh itself fails — which only happens if the refresh token was revoked, expired, or stolen-and-rotated — the frontend hard-redirects to `/login?next=<current path>`.

## Backend

### Schema

This feature touches the `users` table and adds one new table for refresh tokens. The full `users` shape is in `database-schema.md`; the relevant columns here:

- `email` — unique, case-insensitive (citext).
- `password_hash` — bcrypt with cost 12.
- `is_suspended` — boolean. If true, login is refused and any in-flight refresh is rejected.
- `plan`, `credit_balance` — populated at signup with the free-tier defaults.

The new table is `refresh_tokens`, the canonical record of every active refresh token. We never store refresh tokens in plaintext; we hash them so a database compromise doesn't hand an attacker a working session.

- `id` — UUID primary key.
- `user_id` — FK to `users`, cascade on delete.
- `token_hash` — sha256 of the random refresh-token bytes, hex-encoded, uniquely indexed.
- `family_id` — UUID, shared across an entire chain of rotated refresh tokens for one login session. Set at login, copied across rotations. Used for theft detection (see Logic).
- `issued_at` — timestamp.
- `expires_at` — timestamp, `issued_at + 30 days`.
- `revoked_at` — nullable timestamp; non-null means this token cannot be used.
- `replaced_by` — nullable UUID, set when this token has been rotated; points at the new row.
- `user_agent`, `ip_address` — captured at issue time for the dashboard's "active sessions" view (deferred for MVP but the columns are there now to avoid a migration later).

Indexes: unique on `token_hash`; `(user_id, expires_at desc)` for the active-sessions list.

Access tokens are stateless JWTs and not stored.

### Endpoints

All five endpoints live under `/auth/`. Only `/auth/me` and `/auth/logout` require a valid access token; `/auth/refresh` requires only a valid refresh-token cookie.

- `POST /auth/signup` — body `{ email, password }`. Creates a new user with bcrypt-hashed password and the free-plan defaults. On success, issues a token pair (see "The token pair" below), sets both cookies, and returns the user object minus the password hash. On duplicate email, returns 409 with code `EMAIL_TAKEN`.
- `POST /auth/login` — body `{ email, password }`. Looks up the user by email, compares password against the stored hash, refuses if `is_suspended` is true. On success, issues a fresh token pair under a new `family_id`, sets both cookies, returns the user. On failure, returns 401 with a generic "invalid email or password" message — does not leak whether the email exists.
- `POST /auth/refresh` — no body. Reads the refresh-token cookie, validates it (see "Refresh validation"), rotates it (revokes the old row, inserts a new one in the same family, sets `replaced_by` on the old row), issues a fresh access token, sets both cookies. Returns 200 with the user object on success. On any failure — missing cookie, expired token, revoked token, suspended user, theft-detected family — returns 401 with a specific code (`TOKEN_MISSING`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `ACCOUNT_SUSPENDED`, `TOKEN_REUSE_DETECTED`) and clears both cookies.
- `GET /auth/me` — returns the user resolved from the access-token cookie, or 401 with code `TOKEN_EXPIRED` if the access token is missing/invalid/expired. The frontend uses this both at dashboard mount and as the canonical "is the access token still good" check.
- `POST /auth/logout` — revokes the current refresh token row (and, defensively, anything else in the same family), clears both cookies. Always returns 200; safe to call without an active session.

All five use the same response envelope as the rest of the API: success returns the resource directly, failure returns `{ error, code, message }`.

### Logic

**Password rules.** Minimum eight characters. No maximum (bcrypt has its own internal cap, but the validation layer doesn't enforce one). No complexity requirements — long simple passwords beat short complex ones, and we'd rather not annoy people. The eight-char minimum is enforced by zod on the signup endpoint, which rejects with a clear field-level error.

**Hashing.** Passwords are hashed with bcrypt at cost factor 12. This takes roughly 250ms on a typical Render instance, which is intentional — it's slow enough to make brute-force expensive but fast enough for a real user not to notice. The cost factor is centralized so we can bump it later.

**The token pair.**

- *Access token*: a JWT carrying `{ sub: user_id, iat, exp, type: "access" }`, signed HS256 against `JWT_ACCESS_SECRET`. Lifetime is 15 minutes. Set as the `yt_access` httpOnly cookie at `path=/`.
- *Refresh token*: a 32-byte CSPRNG random value, base64url-encoded (~43 chars). Not a JWT — there is nothing to encode in it; it is a database row lookup key. The plaintext value is sent to the client exactly once (as a cookie) and stored only in hashed form (`sha256` hex) on the server. Lifetime is 30 days. Set as the `yt_refresh` httpOnly cookie at `path=/auth`, so it is sent on `/auth/refresh` and `/auth/logout` but not on every dashboard request.

The two-cookie split is deliberate: the refresh token never travels on routine API calls, so the most sensitive credential has the smallest exposure surface.

**Cookie attributes.** Both cookies use `httpOnly: true`, `secure: true` in production, `sameSite: "none"` in production (frontend and backend are different sites), and `path` as above. In development, `secure` is false and `sameSite` is `"lax"`. Cookie max-ages match the corresponding token lifetime.

**Refresh validation (the heart of this feature).** When `/auth/refresh` is called:

1. Read the `yt_refresh` cookie. Missing → 401 `TOKEN_MISSING`.
2. Hash it (sha256), look up the row by `token_hash`. Not found → 401 `TOKEN_REVOKED` (covers logged-out, manually revoked, or never-existed).
3. If `revoked_at` is non-null *and* `replaced_by` is non-null, this token has already been rotated once — it should never be presented again. **Treat this as theft**: revoke the entire family (`UPDATE refresh_tokens SET revoked_at=now() WHERE family_id=$1`), clear both cookies, return 401 `TOKEN_REUSE_DETECTED`. The legitimate user will have to log in again, but the attacker is now also locked out.
4. If `revoked_at` is non-null but `replaced_by` is null, it was explicitly revoked (logout, admin) — return 401 `TOKEN_REVOKED`.
5. If `expires_at <= now()`, return 401 `TOKEN_EXPIRED`. (Don't extend.)
6. If the user is suspended, return 401 `ACCOUNT_SUSPENDED`.
7. Rotate: insert a new row with the same `family_id`, fresh random token, fresh `expires_at`. Update the old row: set `revoked_at=now()`, `replaced_by=<new row id>`. Issue a new access token JWT. Return 200, set both cookies.

The rotation-with-theft-detection is non-negotiable. Without it, a stolen refresh token is a permanent backdoor; with it, the legitimate user's next refresh nukes the attacker's access (or vice versa, but either way both lose access and the user re-authenticates with their password — which the attacker doesn't have).

**Cross-domain cookies in production.** Vercel and Render are different origins. For cookies set by the backend to be sent on subsequent calls from the frontend, three things have to line up: the backend's CORS config must include the exact frontend origin and `credentials: true`; both cookies must be `SameSite=None; Secure`; and the frontend's `fetch` calls must pass `credentials: "include"`. If any one of these is missing, the cookie silently doesn't travel and the user appears logged out on every page load. This is the single most common deployment bug for this kind of stack — call it out in the deploy doc as well. Note specifically that the refresh cookie's `path=/auth` does NOT prevent it from crossing origins; `Path` is a request-URL filter, not a cross-site filter, and `SameSite=None; Secure` is what permits the cross-site send.

**Suspended users.** `is_suspended` is checked in three places: at login (refused with `ACCOUNT_SUSPENDED`), inside the access-token middleware that protects `/me/*` and `/auth/me` (also refused), and inside `/auth/refresh` (refused, cookies cleared). A user who gets suspended mid-session keeps their access token in their cookie jar but can't refresh it; within at most 15 minutes (one access-token lifetime) they're out of the dashboard.

**No email verification.** Signup creates a usable account immediately. The email is stored, but we don't send a confirmation link or check that the address is real. This is a deliberate MVP scope decision. If abuse becomes a problem we'll add it; until then the friction isn't worth it.

**No password reset.** If a user forgets their password in MVP, the only recovery path is to email support and have an admin manually reset it (or delete the account). This is also called out explicitly. A real password-reset flow is a small but non-trivial feature (token table, email sending, expiry, single-use enforcement) and is deferred.

**Rate limiting.** Login is rate-limited per IP — about ten attempts per minute — to make password guessing impractical. Signup is rate-limited per IP at a lower rate (about five per minute) to deter scripted account creation. Refresh is rate-limited per IP at about sixty per minute, which is far above legitimate use (a single tab refreshes about every 15 minutes) but low enough that a botnet can't grind through stolen refresh tokens. These limits live in the same Redis-backed rate-limit infrastructure described in the rate-limiting feature.

**Cleanup of stale rows.** Refresh-token rows where `expires_at < now() - interval '30 days'` (i.e., expired for more than the lifetime so they can never be rotated again) can be hard-deleted by a periodic job. Not in MVP — table will stay small enough at MVP scale that GC is unnecessary. Mark this as a "do later when the table crosses 100k rows."

### Required env vars

- `JWT_ACCESS_SECRET` — HS256 secret for access tokens. Minimum 32 bytes of entropy. Rotating this invalidates every active access token (a feature, not a bug — a deploy-time forced logout switch).
- `ACCESS_TOKEN_TTL_SECONDS` — defaults to 900 (15 minutes). Configurable so we can shorten it under attack or lengthen it during debugging without a code change.
- `REFRESH_TOKEN_TTL_SECONDS` — defaults to 2592000 (30 days). Same reasoning.
- `ACCESS_COOKIE_NAME` — defaults to `yt_access`. The old `yt_session` name is retired.
- `REFRESH_COOKIE_NAME` — defaults to `yt_refresh`.

The old `JWT_SECRET` and `JWT_COOKIE_NAME` env vars are removed. Migration guidance: at deploy, every existing `yt_session` cookie becomes invalid (signed with a secret no longer in use); users will be silently bounced to login on their next page load. Acceptable for an MVP with very few existing users; if the user base is larger when this lands, write a one-shot compatibility shim that accepts either cookie for two weeks.

## Frontend

Two pages plus the user menu plus a single piece of shared infrastructure: the API client's auto-refresh interceptor.

**`/signup`.** Card with fields `email` and `password`, a "Create account" button, and a link "Already have an account? Log in" pointing at `/login`. On submit, calls `POST /auth/signup`. Shows inline field errors from the response, surfaces global errors (network, 500) at the top of the card. On 200, the cookies are already set; routes to `/dashboard`.

**`/login`.** Same layout. Submits to `POST /auth/login`, with the same error handling. On success, redirects to the `?next=` value if present and safe (must be a relative path starting with `/`), otherwise `/dashboard`.

**Dashboard guard.** The dashboard layout is a client component that calls `GET /auth/me` on mount. While the call is pending, it shows a centered spinner. On 200, it renders the children with the user available via React context. On 401 with code `TOKEN_EXPIRED`, the API client (below) handles the refresh transparently and the call is retried — the layout never sees the 401 directly. On 401 from the *retry* (refresh failed), the API client throws a special "auth dead" error and the layout redirects to `/login?next=<current path>`.

**API client interceptor.** This is the only frontend piece the existing implementation does not yet have. The typed `lib/api.ts` client gains a wrapper such that:

1. Every dashboard API call goes through one function (e.g. `apiFetch`).
2. If the response is 401 with code `TOKEN_EXPIRED`, the client calls `POST /auth/refresh` exactly once. If multiple in-flight requests get 401 simultaneously, they share a single refresh promise (a module-level `inflightRefresh` variable) — we never trigger more than one refresh at a time, because each refresh rotates the token and concurrent refreshes would race-trigger the theft-detection branch.
3. If the refresh succeeds, the original request is retried once.
4. If the refresh fails (any 401 from `/auth/refresh`), the client clears any cached user state and throws an `AuthExpiredError`. Top-level page code catches this and redirects to `/login`.
5. The interceptor never retries non-401 errors and never retries after the second 401 (no infinite loops).

Public API calls (`/v1/*` from the playground) bypass this interceptor entirely — they use Bearer keys, not cookies, and the refresh flow is meaningless for them.

**User menu.** Sits in the top-right of the dashboard shell. Shows the user's email and a "Logout" button. Logout calls `POST /auth/logout`, then routes to `/login`. The user context is cleared on the way; both cookies are gone server-side.

## Dependencies

- `database-schema.md` — must be updated to include the `refresh_tokens` table described above. Add a new migration `011_refresh_tokens.sql` (or whatever the next number is).
- The architecture overview's CORS and cookie story must be honored by deploy config (this doc lists the requirements; the deploy doc enforces them). Specifically, `FRONTEND_URL` must include exactly the deployed frontend origin, and the rate-limiting infrastructure (Redis) must be reachable before login/signup/refresh are usable.
- The dashboard shell consumes the user context this feature provides, and now relies on the API client's refresh interceptor for transparent session continuity.

## Verification

A working end-to-end check, all in the browser with devtools open on the Network tab:

1. Hit `/signup`, create an account with a fresh email and a >8-char password. Verify the response sets *both* `yt_access` and `yt_refresh` as httpOnly cookies, with `yt_refresh` scoped to `path=/auth`. Verify you land on `/dashboard`.
2. Reload the dashboard. Confirm `GET /auth/me` returns 200 and the same user. Confirm the `yt_refresh` cookie was NOT sent on this request (path mismatch) but `yt_access` was.
3. Manually expire the access token (devtools → set `yt_access` cookie to a past date, or wait 15 minutes). Trigger any dashboard API call. Confirm the network tab shows: (a) original request → 401 `TOKEN_EXPIRED`, (b) `POST /auth/refresh` → 200 with new `Set-Cookie` for both tokens, (c) original request retried → 200. The user should not perceive any interruption.
4. Manually delete the `yt_refresh` cookie. Trigger an API call. Confirm: original 401, refresh 401 `TOKEN_MISSING`, hard-redirect to `/login?next=...`.
5. **Rotation test.** From devtools, copy the current `yt_refresh` cookie value. Trigger a refresh successfully (so a new value is now set). Now manually paste the *old* value back into the cookie jar and trigger another refresh. Confirm the response is 401 `TOKEN_REUSE_DETECTED`, both cookies are cleared, and you're redirected to `/login`. Verify in the database that ALL rows in that `family_id` now have `revoked_at` set — the theft response nuked the family.
6. Open a new private window, hit `/login`, enter the same credentials. Confirm successful login and redirect. Confirm a new `family_id` was created in `refresh_tokens` (different from any prior session's family).
7. Try logging in with a wrong password. Confirm 401 and the generic error message — verify the response body does NOT distinguish "wrong email" from "wrong password."
8. Manually flip `is_suspended` to true in the database for the test user. Wait for the next access-token refresh (or force one). Confirm the refresh returns 401 `ACCOUNT_SUSPENDED` and the user is bounced to login.
9. From the user menu, log out. Confirm both cookies are cleared and the corresponding refresh-token row in the database has `revoked_at` set. Confirm a follow-up `GET /auth/me` returns 401.
10. From a curl session, exercise login → call `/auth/me` → wait for access-token expiry → call `/auth/refresh` → call `/auth/me` again, all using `--cookie` and `--cookie-jar`. Confirm cookies persist across calls and `Set-Cookie` headers carry `SameSite=None; Secure` in production.

If all ten pass, accounts and sessions are working as specified.
