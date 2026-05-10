# Architecture Overview

## What this is

YouTube Transcripts API is a SaaS that turns any YouTube URL into a clean transcript — JSON, plain text, SRT, or VTT — through a single REST call. Developers sign up, copy an API key from a dashboard, and start hitting `GET /v1/transcript?url=…` against their credit balance. Behind that one endpoint sits a small but opinionated stack: a Node/Express backend, a Postgres database, a Redis cache, and a Next.js dashboard. Most of the surface area is invisible to the customer; the only thing they see is a fast, predictable transcript response.

The product covers more than just the API. The dashboard wraps the same backend with a session-authed UI: usage graphs, billing, an in-browser playground that mimics the real API, and a transcript viewer that loads the YouTube player alongside word-by-word subtitle overlay. Translation to roughly 45 languages is built in, with three quality tiers that fall back automatically. A Whisper fallback handles videos that have no captions at all.

This document is the bird's-eye view. Each subsystem — accounts, API keys, the transcript endpoint, fetchers, caching, billing, the dashboard — has its own feature doc with the actual rules and shapes. Read this one first to understand how the pieces fit; read the feature docs for the details.

## The big picture

There are five moving parts in production:

- A **Next.js frontend** hosted on Vercel. It serves the marketing site, the dashboard, the playground, and the transcript viewer. It talks to the backend over HTTPS and carries a session cookie.
- An **Express backend** hosted on Render. It serves both the public REST API (Bearer-authed, used by customers) and the dashboard API (cookie-authed, used by the frontend).
- A **Postgres database** on Neon. Canonical store for users, keys, subscriptions, cached transcripts, audit logs, and billing events.
- A **Redis cache** on Render Key Value. Hot path for transcript lookups, rate-limit counters, and short-lived session-style data.
- A handful of **external services**: Stripe for billing, OpenAI for Whisper and tier-3 translation, YouTube's public oEmbed endpoint for video metadata, and (in production) a residential proxy provider for YouTube caption fetches.

The frontend is purely a UI layer — it does not own any business logic. Every screen is a thin wrapper around an endpoint on the backend, and the dashboard's session cookie is set by the backend at login. This separation means the API is the product, and the dashboard is one of its consumers.

## Two parallel auth schemes

The backend speaks two authentication languages depending on which mouth it's listening with.

The **dashboard** uses a JWT in an httpOnly cookie called `yt_session`, signed with a server secret, valid for seven days. Login sets the cookie; logout clears it. Every dashboard route on the backend (`/me/*`, `/auth/*`) reads the cookie and resolves to a user. Because the frontend lives on a different origin than the backend in production (Vercel vs Render), the cookie is set with `SameSite=None; Secure` and a configured cross-site CORS policy.

The **public REST API** uses Bearer tokens. Customers send `Authorization: Bearer yt_live_…`. The middleware sha256-hashes the token, looks it up in the `api_keys` table, refuses revoked or expired keys or suspended users, and attaches the resolved user to the request. There is no JWT involved on the API side — the database is the source of truth on every call, so revocation is instant.

The two schemes never overlap. Dashboard endpoints reject Bearer tokens; public API endpoints reject session cookies. This keeps the surface area auditable and makes it impossible to accidentally widen one scheme into the other.

## The transcript request, end to end

A typical `GET /v1/transcript?url=…` flows through roughly eight stages:

1. **Auth and rate limit**: the Bearer middleware resolves the key, then a per-key token bucket check (about 100 requests per minute) decides whether to proceed.
2. **Parse and validate**: the YouTube URL is normalized into an 11-character video id; the format and language params are validated.
3. **Cache lookup**: Redis is checked first for `<video_id>:<language>`, then Postgres `cached_transcripts`. A cache hit is essentially free and skips the rest of the fetch path.
4. **Fetch**: on a miss, the native YouTube caption fetcher runs first. If the video has no captions, the Whisper fallback kicks in (stub or real, depending on env).
5. **Metadata**: in parallel with or just after the fetch, oEmbed gives us title, channel, and thumbnail.
6. **Credits**: the cost is calculated (cheaper for native, more expensive for Whisper, plus a translation surcharge), checked against the user's balance, and deducted in a single transaction with a `credit_transactions` audit row.
7. **Translate (optional)**: if `translate_to` was passed, the transcript runs through the three-tier translator (stub, free, paid).
8. **Cache, format, respond, log**: the result is written back to Redis and Postgres, formatted into the requested shape (JSON, text, SRT, VTT), returned to the caller with `X-Credits-*` headers, and a row is written to `api_requests` for analytics.

Almost every step has its own feature doc. The orchestration itself lives in `transcript-endpoint.md`.

## Two-tier caching, and why it matters in production

Transcripts are cached in two places. **Redis** holds a small TTL'd copy keyed by video id and language for the hot path. **Postgres** holds the canonical, long-lived copy in the `cached_transcripts` table. A request checks Redis first, then Postgres on miss; a fresh fetch writes back to both.

This structure looks like ordinary cache-aside, but in production it does double duty. YouTube blocks datacenter IPs, and Render's egress IPs are firmly in that bucket. A real production deployment without a residential proxy can only serve videos that are already in the shared Postgres cache — the first request for a brand-new video will fail unless a proxy is configured. This is a known constraint and the architecture acknowledges it: the Postgres cache becomes a quasi-CDN of every transcript that any customer has ever pulled, and the proxy is the only way to grow that set. See `youtube-and-whisper.md` for the proxy story and `cached_transcripts` in `database-schema.md` for the schema.

## Translation in three tiers

Translation is not a single integration; it's a tier-down chain. The orchestrator tries them in this order:

1. **Stub** — used in dev when `STUB_TRANSLATION=true`. Prefixes each segment with the target language code so the wiring can be tested without external calls.
2. **Free** — `google-translate-api-x`, an unauthenticated wrapper around Google's public endpoints. No API key, decent quality, but rate-limited and occasionally fragile.
3. **Paid** — OpenAI's `gpt-4o-mini` with a translation prompt. Highest quality, costs real money, and is gated behind a higher credit cost.

The user does not pick the tier. The system tries free first, and if it fails or is disabled, it tries paid. The credit cost for `translate_to=…` reflects the worst-case path. Tier selection is centralized so it can be tuned without touching the transcript endpoint.

## Stub-aware everything

Every paid or fragile external integration has a stub mode controlled by an env flag. `STUB_STRIPE` skips real Stripe calls and pretends webhooks succeeded. `STUB_WHISPER` returns canned 30-second segments instead of calling OpenAI. `STUB_PROXY` skips the residential proxy and goes direct (fine in dev, broken in prod). `STUB_TRANSLATION` short-circuits to the prefix translator.

The point is that a developer can clone the repo, set zero secrets, and run the whole product end-to-end against fake external services. The same code paths run in stubbed and real modes — only the external call at the leaf is swapped — so the orchestration is exercised the same way either way. This is also how CI runs, and it's why none of the docs treat external services as load-bearing for development.

## Tech choices and why

A short list, since each picks shows up repeatedly in the feature docs:

- **Node 20 + TypeScript + Express 4**: small, well-known, easy to read. Fastify or Hono would also work; Express was chosen for ecosystem familiarity since this is a developer-facing product and contributors will be reading the source.
- **pg (raw)**: no ORM. Queries are short, schemas are simple, and the absence of an ORM keeps the migration story to plain SQL files. Zod handles input validation; pg handles the rest.
- **ioredis**: standard Redis client, supports clustering if we ever need it.
- **zod**: every public endpoint validates its input with a zod schema. Failures return a uniform error envelope.
- **Next.js 14 App Router (src dir) + Tailwind v3 + shadcn/ui**: standard modern React stack. App Router gives us server components for the marketing site and client components for the dashboard. Tailwind v3 (not v4) is pinned because shadcn/ui's defaults assume v3.
- **PostgreSQL 16 / Redis 7**: nothing exotic. The schema fits comfortably in a single Postgres instance; Redis is used for caching and rate limiting, not as a primary store.
- **JWT in httpOnly cookie**: avoids storing tokens in JS. Seven-day expiry, no refresh token complexity in MVP.
- **sha256 for API keys**: keys are random 24-byte tokens, not passwords. They don't need bcrypt — sha256 is sufficient and constant-time-comparable, and it lets the lookup happen with a single indexed query.

## How to read the rest of these docs

`database-schema.md` is the next most useful file — every feature touches it, so reading it second makes the others go faster. After that, the feature docs can be read in any order, but a natural sequence is `user-accounts-and-sessions.md` → `api-keys.md` → `transcript-endpoint.md` → `youtube-and-whisper.md`. Each feature doc lists its dependencies on other features explicitly under a "Dependencies" heading.
