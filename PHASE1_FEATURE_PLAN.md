# Phase 1 MVP — Feature Plan
**YouTube Transcripts API**  
**Timeline:** 4-6 weeks  
**Goal:** Ship a paying product with a single core API endpoint that reliably fetches transcripts and takes Stripe payments.

---

## Executive Summary

Phase 1 delivers a minimum viable product (MVP) with one REST API endpoint (`GET /v1/transcript`) that accepts a YouTube URL and returns a transcript in multiple formats. The product is supported by:

- A Postgres database (users, API keys, cached transcripts, billing)
- Redis caching and rate limiting
- Residential proxies for YouTube scraping
- Whisper fallback for videos without captions
- Stripe billing and credit-based usage model
- A simple user dashboard for key management and usage tracking
- Public API documentation and a marketing landing page

**Success criteria for Phase 1:**
- MVP takes payments (Stripe subscriptions working end-to-end)
- Single transcript endpoint functional across 10+ test videos with varying conditions
- Latency targets: sub-100ms for cached, sub-500ms for fresh fetches
- Whisper fallback working reliably
- User dashboard operational (signup, login, API key, usage, billing)
- Public docs clear enough for integration in under 5 minutes

---

## Feature List (Prioritized)

### Tier 1 — MVP Core (Critical Path)
These features *must* ship in Phase 1. They are blocking and interdependent.

| # | Feature | Description | Est. Effort | Dependencies |
|---|---------|-------------|-------------|--------------|
| 1 | **API Endpoint: GET /v1/transcript** | Core endpoint. Accepts YouTube URL, returns transcript. Supports all output formats. | 2-3 days | YouTube fetching, format converters, caching |
| 2 | **YouTube Transcript Fetching** | Fetch native captions from YouTube via youtube-transcript-api, routed through residential proxies. | 2-3 days | Proxy setup, error handling |
| 3 | **Whisper Fallback** | For videos without native captions, download audio and transcribe via OpenAI Whisper API. | 2 days | OpenAI integration, error handling, credit deduction |
| 4 | **Output Format Converters** | Convert transcript to JSON, plain text, SRT, VTT. | 1-2 days | None (post-fetch) |
| 5 | **Language Detection** | Auto-detect and return language of transcript. Support 100+ languages. | 1 day | None (built into YouTube captions) |
| 6 | **Redis Caching** | Cache transcripts after first fetch. Target sub-100ms response on hit. | 1-2 days | Database, API endpoint |
| 7 | **Authentication (API Keys)** | Bearer token auth in headers. Validate against user records. | 1 day | Database, user management |
| 8 | **Database Schema** | Postgres tables for users, API keys, cached transcripts, credit balance, billing. | 1 day | None |
| 9 | **Credit System** | Track usage per user. Deduct credits per transcript. Support native captions (1 credit) and Whisper (1 credit/min). | 1 day | Database, API endpoint, billing |
| 10 | **Rate Limiting** | Redis-based per-user rate limiting. Prevent abuse. | 1 day | Redis, authentication |
| 11 | **Error Handling** | Handle age-restricted videos, private videos, deleted videos, network failures gracefully. Return meaningful error codes. | 1-2 days | API endpoint, external integrations |
| 12 | **User Dashboard (Web UI)** | Signup, login, API key management, usage history, credit balance. Simple HTML/React UI. | 3-4 days | Database, authentication, frontend framework |
| 13 | **Stripe Billing Integration** | Monthly subscriptions, credit assignment, Stripe webhook handling for payment success/failure. | 2-3 days | Database, user dashboard, Stripe SDK |
| 14 | **Public API Documentation** | API reference, code examples (curl, Python, Node.js), error codes, authentication. Deployed as simple HTML or Markdown site. | 2 days | API endpoint (finalized) |
| 15 | **Marketing Landing Page** | Hero section, feature highlights, pricing table, CTA to sign up. Emphasize speed, Whisper inclusion, and competitive edge. | 2-3 days | Pricing finalized, brand assets |

**Tier 1 Total Effort:** ~28-37 days (5-7 weeks). **Critical path:** Start with #1-7 in parallel, then #8-15 depend on #1-7.

---

### Tier 2 — Polish & Testing (In-scope if time permits)
These features improve UX but are not blockers for launch.

| # | Feature | Description | Est. Effort |
|---|---------|-------------|-------------|
| 16 | **Interactive API Playground** | In-browser test endpoint (curl generator, request/response viewer). | 2 days |
| 17 | **Usage Analytics Dashboard** | Charts of requests/credits over time, peak hours, top videos. | 2 days |
| 18 | **Bulk Transcript Endpoint** | `POST /v1/transcript/bulk` — fetch 100+ transcripts in one call. | 1-2 days |
| 19 | **Webhook Support** | Notify user when transcript is ready (async processing). | 1-2 days |
| 20 | **Admin Panel** | View users, credit balance, billing status, manually adjust credits. | 1-2 days |

---

## Implementation Phases Within Phase 1

### Sprint 1: Foundation (Week 1-2)
**Goal:** Core infrastructure and transcript fetching working.

- [ ] Set up project structure (Node.js/Python, Express/FastAPI, Postgres, Redis)
- [ ] Database schema (users, API keys, transcripts, billing)
- [ ] YouTube transcript fetching (youtube-transcript-api + proxy rotation)
- [ ] Basic error handling for common failure cases
- [ ] Whisper integration (OpenAI API)
- [ ] Output format converters (JSON → SRT, VTT, plain text)
- [ ] Test on 10 videos across conditions

**Deliverable:** Working CLI: `node transcript.js <url>` outputs transcript.

---

### Sprint 2: API & Auth (Week 2-3)
**Goal:** Production-ready REST API with authentication.

- [ ] Express/FastAPI server setup
- [ ] `GET /v1/transcript` endpoint fully functional
- [ ] API key authentication middleware
- [ ] Redis caching layer
- [ ] Rate limiting per API key
- [ ] Credit deduction logic
- [ ] Error responses (standardized, meaningful)
- [ ] Logging and monitoring

**Deliverable:** Working API. Test with curl and SDK code examples.

---

### Sprint 3: Database & Billing (Week 3-4)
**Goal:** User management and Stripe payments.

- [ ] User signup/login (email, password hashing)
- [ ] Stripe subscription creation (Free, Starter, Pro, Business plans)
- [ ] Monthly credit assignment based on plan
- [ ] Webhook handling (payment_intent.succeeded, charge.failed)
- [ ] Credit balance persistence
- [ ] Usage history logging

**Deliverable:** End-to-end signup → subscribe → use API → credit deduction.

---

### Sprint 4: Dashboard & Docs (Week 4-5)
**Goal:** User-facing UI and public documentation.

- [ ] Dashboard frontend (signup form, login, API key display, usage history, billing link)
- [ ] API key regeneration
- [ ] Usage stats view
- [ ] Public docs site (OpenAPI spec, curl examples, Python/Node examples, error codes)
- [ ] Marketing landing page
- [ ] Deployment (Railway or DigitalOcean)

**Deliverable:** Fully functional SaaS product, ready to accept paying customers.

---

### Sprint 5: Testing & Hardening (Week 5-6)
**Goal:** Reliability and polish.

- [ ] Comprehensive test suite (unit, integration, end-to-end)
- [ ] Load testing (cache hit rates, latency under load)
- [ ] Edge case testing (non-English videos, age-restricted, no captions, deleted videos)
- [ ] Monitoring setup (error tracking, performance metrics, uptime alerts)
- [ ] Security audit (API key rotation, HTTPS, CORS, input validation)
- [ ] Documentation review and polish
- [ ] Prepare launch checklist

**Deliverable:** Hardened, production-ready service. Ready for soft launch.

---

## Technical Dependencies & Prerequisites

### External Services
- **YouTube API / youtube-transcript-api:** For fetching captions
- **Residential Proxies:** Bright Data, Smartproxy, or Webshare (~$200-500/mo)
- **OpenAI Whisper API:** For transcription fallback (~$0.006/min audio)
- **Stripe:** For payment processing
- **Email Service:** SendGrid or AWS SES for transactional emails (signup, billing)

### Infrastructure
- **Postgres:** Database (local dev, managed service for prod)
- **Redis:** Cache and rate limiting (local dev, Redis Cloud or ElastiCache for prod)
- **Hosting:** Railway, DigitalOcean, or AWS (auto-scaling not needed for Phase 1)
- **Domain:** TBD (handle separately)

### Development Tools
- **Backend Framework:** Node.js + TypeScript (Express) OR Python (FastAPI)
- **Frontend:** React, Vue, or vanilla HTML/CSS for dashboard
- **API Documentation:** OpenAPI spec + Swagger UI or custom HTML
- **Testing:** Jest (Node) or Pytest (Python), Postman for API testing
- **Monitoring:** Sentry (error tracking), DataDog or Grafana (optional)
- **Version Control:** Git (GitHub)

---

## Success Criteria

### Functional
✅ `GET /v1/transcript` endpoint accepts YouTube URL and returns valid transcript  
✅ Supports all 4 output formats (JSON, plain text, SRT, VTT)  
✅ Native captions fetched for 100+ test videos  
✅ Whisper fallback working for videos without captions  
✅ Language detection and auto-language selection working  
✅ API key authentication required and enforced  
✅ Rate limiting prevents abuse (100 req/min per key, tunable)  
✅ Caching reduces latency (sub-100ms on cache hit)  
✅ Credit system deducts correctly (1 credit per native transcript, 1 per minute for Whisper)  
✅ Stripe billing end-to-end (signup → subscribe → credit assignment → usage deduction)  
✅ User dashboard fully functional (signup, login, key management, usage, billing)  

### Performance
✅ Cached transcript response: **< 100ms**  
✅ Fresh transcript (native captions): **< 500ms**  
✅ Whisper fallback: **< 30 seconds** (depends on video length)  
✅ API availability: **99.5%** uptime  
✅ Error responses: **< 1 second**  

### User Experience
✅ Signup to first API call: **< 2 minutes**  
✅ API docs clear enough for integration in **< 5 minutes**  
✅ Error messages are actionable (not generic "500 error")  
✅ Pricing page transparently shows what each plan includes  
✅ Free tier available for low-volume users (lead magnet)  

### Competitive
✅ Whisper included in standard credits (not premium tier)  
✅ Transparent pricing, no surprise overage charges  
✅ Faster onboarding than TranscriptAPI.com  
✅ Sub-500ms latency competitive with or better than competitors  

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **YouTube blocks proxy IPs** | Fetching fails, service unavailable | Use reputable proxy provider (Bright Data), monitor success rates, have fallback providers |
| **Whisper API rate limits or costs spike** | Unexpected costs, service degradation | Start with OpenAI API, monitor usage, plan self-hosted Whisper for Phase 2 |
| **Postgres/Redis downtime** | Data loss, service unavailable | Use managed services (Railway, AWS RDS), automated backups, multi-region replication later |
| **Stripe webhook failures** | Billing breaks, users don't get credits | Implement retry logic, monitor webhook queue, manual credit adjustment in admin panel |
| **Age-restricted videos fail silently** | User frustration, poor UX | Detect age restriction early, return clear error with workaround info |
| **Regulatory: YouTube ToS violation** | Legal cease-and-desist | Use official YouTube API where possible, document fair-use for transcript fetching, monitor TOS updates |

---

## File Structure (Recommended)

```
/youtube-transcripts-api
├── PHASE1_FEATURE_PLAN.md (this file)
├── docs/
│   ├── FEATURE_API_ENDPOINT.md
│   ├── FEATURE_YOUTUBE_FETCHING.md
│   ├── FEATURE_WHISPER_FALLBACK.md
│   ├── FEATURE_OUTPUT_FORMATS.md
│   ├── FEATURE_LANGUAGE_DETECTION.md
│   ├── FEATURE_CACHING.md
│   ├── FEATURE_AUTHENTICATION.md
│   ├── FEATURE_DATABASE_SCHEMA.md
│   ├── FEATURE_CREDIT_SYSTEM.md
│   ├── FEATURE_RATE_LIMITING.md
│   ├── FEATURE_ERROR_HANDLING.md
│   ├── FEATURE_DASHBOARD.md
│   ├── FEATURE_STRIPE_BILLING.md
│   ├── FEATURE_API_DOCS.md
│   ├── FEATURE_LANDING_PAGE.md
│   └── FEATURE_DEPLOYMENT.md
├── src/
│   ├── api/
│   ├── db/
│   ├── cache/
│   ├── services/
│   ├── middleware/
│   └── ...
├── tests/
├── public/ (dashboard + landing page)
└── README.md
```

---

## Next Steps

1. **Read detailed feature docs** — Review each feature implementation plan
2. **Confirm tech stack** — Lock in Node.js/Python, Postgres version, Redis version
3. **Confirm proxy provider** — Bright Data, Smartproxy, or Webshare?
4. **Set up project structure** — Create repo, initialize git, set up CI/CD basics
5. **Start Sprint 1** — Focus on YouTube fetching + Whisper integration

---

**Version:** 1.0  
**Last Updated:** 2026-05-09  
**Owner:** Dorik Team  
**Status:** Kickoff
