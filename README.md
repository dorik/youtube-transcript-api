# YouTube Transcripts API — Phase 1 MVP

A REST API + dashboard for YouTube video transcripts. Send a YouTube URL, get back a transcript in JSON, plain text, SRT, or VTT.

- **Backend:** Node.js + Express + TypeScript
- **Frontend:** Next.js 14 + Tailwind + shadcn/ui
- **DB / Cache:** PostgreSQL (Neon or Docker) + Redis
- **External:** Stripe, OpenAI Whisper, residential proxies (real services — no stub mode)

---

## Quick start

### 1. Prerequisites

- Node 18+ and npm 10+
- A Postgres database — either Docker (`docker compose up -d`) or a managed one (Neon, Supabase). Connection string goes in `backend/.env` as `DATABASE_URL`.
- Redis running locally on `localhost:6379`. The repo's `docker-compose.yml` brings one up; if you have it installed natively (e.g. `brew install redis`), `redis-server` works too.

### 2. Backend

```bash
cd backend
cp .env.example .env       # edit DATABASE_URL, REDIS_URL, JWT_SECRET as needed
npm install
npm run db:migrate         # apply 9 SQL migrations
npm run dev                # ts-node-dev on port 3001
```

Health check: `curl http://localhost:3001/health` should return `{"status":"ok",…}`.

### 3. Frontend

```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev                # next dev on port 3000
```

Visit [http://localhost:3000](http://localhost:3000).

### 4. Smoke test

1. Sign up at [http://localhost:3000/signup](http://localhost:3000/signup).
2. Open the dashboard → API Keys → **Create key** → copy the plaintext.
3. Visit `/playground`, paste the key, click **Fetch transcript**.

Or via curl:
```bash
curl 'http://localhost:3001/v1/transcript?url=https://youtu.be/dQw4w9WgXcQ' \
  -H 'Authorization: Bearer yt_live_YOUR_KEY'
```

---

## External services

There is no stub mode. The backend talks to real Stripe, real OpenAI, and the
real outbound proxy. Each integration's failure mode is a hard error (HTTP 4xx
/ 5xx) rather than a fake response.

| Integration | Env vars | What breaks without them |
|---|---|---|
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_*` | Checkout / change-plan / webhooks all 500 |
| OpenAI Whisper | `OPENAI_API_KEY` (plus `yt-dlp`, `ffmpeg` on PATH) | Free-plan users always rejected with `UPGRADE_REQUIRED` (no Whisper for them anyway); paid users see a 500 when no native captions exist |
| Translation | `OPENAI_API_KEY` (preferred; falls back to free `google-translate-api-x`) | Translation requests propagate the upstream error |
| Outbound proxy | `PROXY_URL` | YouTube fetches from datacenter IPs get rate-limited / bot-walled |

Free-plan users hitting Whisper get HTTP 402 `UPGRADE_REQUIRED` — Whisper is
a paid-plan feature.

---

## API surface

### Public
- `GET /` — service info
- `GET /health` — DB + Redis health
- `GET /plans` — pricing data (single source of truth)

### Auth (cookie session for the dashboard)
- `POST /auth/signup` `{ email, password }` → sets `yt_session` cookie
- `POST /auth/login` `{ email, password }`
- `POST /auth/logout`
- `GET /auth/me`

### Account (cookie auth)
- `GET /me/api-keys` — list keys
- `POST /me/api-keys` `{ name? }` — create; returns plaintext **once**
- `DELETE /me/api-keys/:id` — revoke
- `GET /me/subscription` — current plan + credit balance
- `GET /me/usage` — totals, by-source breakdown, daily histogram, recent requests

### Billing
- `POST /billing/checkout` `{ plan }` — returns Stripe Checkout URL
- `POST /billing/change-plan` `{ plan }` — swap an active subscription
- `POST /webhooks/stripe` — Stripe webhook receiver

### Transcripts (Bearer API key auth)
- `GET /v1/transcript?url=…&format=…&language=…` — see `frontend/src/app/docs/page.tsx` or `docs/FEATURE_API_ENDPOINT.md` for the full spec.

---

## Project layout

```
backend/
├── src/
│   ├── index.ts, app.ts          # entry + Express composition
│   ├── config/                   # env (zod) + logger
│   ├── db/                       # pg Pool + migrations runner + SQL files
│   ├── cache/                    # ioredis client
│   ├── middleware/               # apiKeyAuth, sessionAuth, rateLimit, errorHandler
│   ├── services/                 # business logic
│   │   ├── transcriptService.ts  # orchestrator (cache → fetch → Whisper → credits)
│   │   ├── youtubeService.ts     # native captions via yt-dlp
│   │   ├── whisperService.ts     # Whisper (paid-plan only)
│   │   ├── cacheService.ts       # Redis + Postgres two-tier
│   │   ├── creditService.ts      # transactional credit deductions
│   │   ├── stripeService.ts      # checkout + webhook dispatch
│   │   └── formatters.ts         # JSON / text / SRT / VTT
│   ├── routes/                   # Express routers (auth, transcript, billing, …)
│   └── utils/                    # youtubeUrl, errors, password
└── package.json

frontend/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Landing
│   │   ├── pricing/, docs/, playground/, login/, signup/
│   │   └── dashboard/            # layout + overview/api-keys/usage/billing
│   ├── components/
│   │   ├── ui/                   # shadcn primitives
│   │   ├── marketing/            # site-nav, site-footer
│   │   └── dashboard/            # sidebar, topbar
│   └── lib/
│       ├── api.ts                # typed backend client (single source of truth)
│       └── server-auth.ts        # server-side session check (`requireUser`)
└── package.json

docker-compose.yml                # postgres:16 + redis:7
```

---

## Useful commands

```bash
# Backend
cd backend
npm run dev          # auto-reload dev server (port 3001)
npm run db:migrate   # apply pending migrations
npm run typecheck    # tsc --noEmit
npm run build        # compile to dist/

# Frontend
cd frontend
npm run dev          # next dev (port 3000)
npm run build        # next build
npm run lint
```

---

## Phase 1 status

| Group | Status |
|---|---|
| A — Project scaffold + Docker + bootstrap | ✅ |
| B — DB pool, migrations, Redis, config, error handling, health | ✅ |
| C — Auth (signup, login, sessions, API keys, middleware) | ✅ |
| D — Transcript pipeline (URL parser, formatters, YouTube, Whisper, cache, credits, `/v1/transcript`) | ✅ |
| E — Billing + dashboard APIs (Stripe, `/me/usage`, `/me/subscription`) | ✅ |
| F — Marketing site (landing, pricing) | ✅ |
| G — Auth pages (signup, login, typed API client) | ✅ |
| H — Dashboard (overview, api-keys, usage, billing) | ✅ |
| I — Public tools (docs reference, playground) | ✅ |
| J — README + run instructions | ✅ |

Phase 2 (search, channel, playlist, MCP server, SDKs) is intentionally out of scope.

---

## Notes / quirks

- **Cookie session ports:** Both apps use `localhost`, so the JWT cookie's `path=/` works across `:3000` (frontend) and `:3001` (backend) without subdomain or SameSite gymnastics. In production you'll want both on the same eTLD (e.g. `app.youtubetranscripts.co` and `api.youtubetranscripts.co`).
- **API key plaintext is shown once.** The hash is sha256 in `api_keys.key_hash`; we never store the raw token.
- **Cache is two-tier:** Redis is the hot path (30-day TTL); Postgres `cached_transcripts` is the durable backup. Cleanup of expired Postgres rows is left to a scheduled job (not yet implemented; safe to leave for low volume).
- **Whisper requires a paid plan.** Free-plan callers get HTTP 402 `UPGRADE_REQUIRED`; the route is gated in `transcribeWithWhisper` via the per-request `allowRealWhisper` flag.
- **Billing flow:** `Upgrade` button → `/billing/checkout` returns a real Stripe Checkout URL → user pays → webhook (`/webhooks/stripe`) lands and `applyPlanUpgrade` flips the plan + refills credits. Plan switches on existing subscriptions go through `/billing/change-plan` (avoids minting a second Subscription and double-billing).
