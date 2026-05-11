# YouTube Transcripts API — Phase 1 MVP

A REST API + dashboard for YouTube video transcripts. Send a YouTube URL, get back a transcript in JSON, plain text, SRT, or VTT.

- **Backend:** Node.js + Express + TypeScript
- **Frontend:** Next.js 14 + Tailwind + shadcn/ui
- **DB / Cache:** PostgreSQL (Neon or Docker) + Redis
- **External (stubbed):** Stripe, OpenAI Whisper, residential proxies

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

## Stub flags

External paid services are stubbed for local development. Flip these to `false` in `backend/.env` when you have the credentials.

| Flag | What stubbing does | Real mode requires |
|---|---|---|
| `STUB_STRIPE` | Checkout returns a fake redirect; `/billing/stub-activate` upgrades the user locally; webhooks no-op | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_*` |
| `STUB_WHISPER` | Whisper returns canned 30-second transcripts | `OPENAI_API_KEY`, `yt-dlp` and `ffmpeg` installed (`brew install yt-dlp ffmpeg`) |
| `STUB_PROXY` | YouTube fetches go through plain Node fetch (your IP) | `PROXY_URL` for residential proxy provider (Bright Data, Smartproxy, Webshare) |

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
- `POST /billing/checkout` `{ plan }` — returns Stripe (or stub) URL
- `POST /billing/stub-activate` `{ plan }` — local-only upgrade in stub mode
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
│   │   ├── whisperService.ts     # Whisper (real + stub)
│   │   ├── cacheService.ts       # Redis + Postgres two-tier
│   │   ├── creditService.ts      # transactional credit deductions
│   │   ├── stripeService.ts      # checkout + webhook dispatch (real + stub)
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
| E — Billing + dashboard APIs (Stripe stub-aware, `/me/usage`, `/me/subscription`) | ✅ |
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
- **Whisper stub returns 30-second canned segments**, enough to exercise credit math (1 credit) and SRT/VTT formatters.
- **Stripe stub flow:** `Upgrade` button → `/billing/checkout` returns `/dashboard/billing?stub_success=1&plan=pro` → that page calls `/billing/stub-activate` to set the plan and reset credits. Live mode just redirects to Stripe.
