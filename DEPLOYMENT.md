# Deployment

End-to-end recipe for the production setup we use:

| Layer | Provider |
|---|---|
| **Frontend** (Next.js) | Vercel |
| **Backend** (Express API) | Render — Web Service |
| **Redis cache** | Render — Key Value (managed) |
| **Postgres** | Neon (external, already set up) |

The repo ships with a [`render.yaml`](./render.yaml) blueprint and a
[`frontend/vercel.json`](./frontend/vercel.json), so most of the wiring is
automated. You'll fill in three secrets by hand: the Neon `DATABASE_URL`,
your Vercel domain (so the backend can CORS-allow it), and the Render API
URL (so the frontend can reach the backend).

The order matters: **deploy backend first**, copy its URL into the Vercel
project, deploy the frontend, then copy the Vercel URL back into the
backend's `FRONTEND_URL`.

---

## 1. Backend → Render

1. **Push the repo to GitHub** (already done if you're following the
   README).
2. Go to **<https://dashboard.render.com/blueprints>** → **New Blueprint Instance**.
3. Connect the GitHub repo `imbillal/transcriptapi`.
4. Render reads `render.yaml` and proposes:
   - `yt-transcripts-api` — web service (Node, free plan)
   - `yt-transcripts-redis` — Key Value (free plan)
5. Render prompts for the env vars marked `sync: false`. Fill them in:
   - **`DATABASE_URL`** — your full Neon connection string with
     `?sslmode=require`. Get it from
     <https://console.neon.tech> → your project → Dashboard → Connection string.
   - **`FRONTEND_URL`** — leave blank for now. We'll come back to it after
     Vercel is up.
   - The Stripe / OpenAI / Proxy fields can stay empty — the corresponding
     `STUB_*` flags are still `true`, so the service runs in stub mode for
     those providers.
6. Click **Apply**. Render runs:
   - `npm install --include=dev && npm run build` (compiles TS → JS, copies
     migrations into `dist/`)
   - `npm run start:prod` (runs migrations idempotently, then starts the
     server)
7. Once the deploy is healthy (`/health` returns 200 with `db: ok` and
   `redis: ok`), copy the **service URL** — something like
   `https://yt-transcripts-api.onrender.com`.

> **Note on Neon + Render**: Neon's free tier auto-suspends after a few
> minutes of inactivity. The first request after a cold start takes ~3–4
> seconds while it spins back up; subsequent requests are sub-100ms. Same
> story for Render's free web service plan — it sleeps after 15 minutes idle
> and wakes on the next request.

---

## 2. Frontend → Vercel

1. Go to **<https://vercel.com/new>** → **Import Git Repository** → select
   `imbillal/transcriptapi`.
2. **Root Directory**: click "Edit" and select **`frontend`** (not the repo
   root).
3. **Framework preset**: Vercel auto-detects Next.js. Leave defaults.
4. **Environment variables** — add one:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://yt-transcripts-api.onrender.com` (your Render URL from step 1) |

5. Click **Deploy**.
6. After ~60 seconds you'll have a URL like
   `https://transcriptapi.vercel.app`. Copy it.

### 2a. Wire the frontend URL back into the backend

The backend currently rejects all CORS requests because `FRONTEND_URL` is
unset. Fix it:

1. Render dashboard → `yt-transcripts-api` → **Environment** tab.
2. Set **`FRONTEND_URL`** to your Vercel URL (no trailing slash). If you
   want to support both production + preview deploys, comma-separate them:
   ```
   https://transcriptapi.vercel.app,https://transcriptapi-git-main-imbillal.vercel.app
   ```
3. Save. Render automatically restarts the service (~30 seconds).

---

## 3. Smoke test

```bash
# Backend health
curl https://yt-transcripts-api.onrender.com/health

# Public plans (no auth needed)
curl https://yt-transcripts-api.onrender.com/plans

# Frontend — open in a browser, sign up, create a key, hit the playground
open https://transcriptapi.vercel.app
```

If the dashboard says "Sign in required" right after signup, the cookie
domain probably failed. Check that:
- Backend is HTTPS (Render is by default).
- Frontend origin is in `FRONTEND_URL` exactly (scheme + host, no path,
  no trailing slash).
- `NODE_ENV=production` on Render (the `render.yaml` sets it explicitly).

---

## 4. Promoting from stub to live mode

Each external integration is gated behind a `STUB_*` flag. Flip them in
the Render env vars when you're ready:

| Flag | What flips it on |
|---|---|
| `STUB_STRIPE=false` | Real Stripe billing. Also fill `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the three `STRIPE_PRICE_ID_*`. Add a webhook endpoint in Stripe dashboard pointing at `https://yt-transcripts-api.onrender.com/webhooks/stripe`. |
| `STUB_WHISPER=false` | OpenAI Whisper for videos without native captions. Fill `OPENAI_API_KEY` and ensure `yt-dlp` + `ffmpeg` are available — Render's default Node runtime doesn't include them, so you'll need a `Dockerfile` if you go this route on Render. (Fly.io or a custom image is easier.) |
| `STUB_TRANSLATION=false` | Already `false` by default in `render.yaml`. With no `OPENAI_API_KEY` it falls back to the free `google-translate-api-x`. With one set, OpenAI runs (better quality). |
| `STUB_PROXY=false` | Use a residential proxy provider for YouTube fetches. Fill `PROXY_URL` (e.g. `http://user:pass@proxy.provider.com:8080`). |

---

## 5. Post-deploy checklist

- [ ] `/health` returns `{"status":"ok","db":"ok","redis":"ok"}`.
- [ ] Signup works at the Vercel URL and lands you on the dashboard.
- [ ] `/dashboard/api-keys` lets you create a key.
- [ ] `/dashboard/transcripts/new` accepts a YouTube URL and routes to the viewer.
- [ ] Viewer plays the video, segments highlight, subtitles overlay match.
- [ ] `/dashboard/transcripts` shows your recent fetches.
- [ ] Translate dropdown in the viewer toolbar produces real translations.

If any of these fail, `Render dashboard → yt-transcripts-api → Logs` is
the first place to look — every error is logged with the request id.

---

## Local production parity

To run the same compiled artifact locally (e.g. before pushing):

```bash
cd backend
npm run build
NODE_ENV=production npm run start:prod
```

The frontend can still run `npm run dev` against this; just point its
`NEXT_PUBLIC_API_URL` at `http://localhost:3001`.
