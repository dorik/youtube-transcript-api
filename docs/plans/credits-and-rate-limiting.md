# Credits and Rate Limiting

## What this is

Every paid API needs two layers of usage control: a long-horizon quota that aligns with what the customer is paying per month, and a short-horizon throttle that protects the service (and the customer's own bill) from runaway loops or accidental DDoS. We call these credits and rate limits respectively, and they are separate systems with separate failure modes and separate response codes.

Credits are a monthly quota expressed in whole units, deducted from the customer's balance on every request that does real work, and refilled when a billing cycle renews. The free plan ships with 50 credits a month, which is enough to evaluate the API on a handful of videos. Paid plans scale up — Starter at 1,000, Pro at 10,000, Business at 100,000 — and a customer who runs out before their next renewal either upgrades or stops being served. We never partially serve a request: if a customer has 3 credits left and asks for a transcript that costs 5, we return 402 Payment Required cleanly rather than burning through their balance and then throwing partway through.

Rate limits are a per-minute ceiling on requests per API key. Free plan is 10 requests per minute, Starter 60, Pro 100, Business 300. These are independent of credits — a Pro customer with 0 credits remaining still gets rate-limited to 100 requests per minute on the 402 responses, because we don't want a misbehaving client to flood our error path either. The bucket is implemented in Redis with a per-minute key, INCRed on every request, with the response carrying standard rate-limit headers so well-behaved clients can self-throttle.

The two systems are deliberately decoupled. Credits live in Postgres because they are real money; rate limits live in Redis because they are best-effort throttling. A Redis outage degrades rate limiting (we fail open and let requests through) but credits keep working. A Postgres outage breaks credits, which by definition breaks the API, which is the right behavior — we'd rather refuse service than serve unbilled.

## Backend

### Schema

For credits, the `users` table needs three columns:
- `credit_balance` — an integer, the current balance, source of truth. Decremented on each charged request and reset on plan renewal. This single value is what the deduction logic reads and writes.
- `plan` — a text enum (`free`, `starter`, `pro`, `business`) that determines the monthly allotment and rate limit. Updated by Stripe webhooks (see billing).
- `current_period_end` — a timestamp marking when the current billing cycle ends. Used by the dashboard to show "renews in N days" and by the renewal webhook handler.

A `credit_transactions` audit log table is also needed, with one row per balance change:
- `user_id` — who.
- `delta` — signed integer; negative for deductions, positive for grants and refunds.
- `reason` — a short string code: `request_native`, `request_whisper`, `translation_surcharge`, `translation_refund`, `plan_renewal`, `plan_upgrade_grant`, `manual_adjustment`.
- `balance_after` — the new running balance after this row was applied. Stored denormalized so we can audit without reconstructing.
- `request_id` — optional foreign key to `api_requests` when the transaction was caused by a specific request, so support can trace "why did I lose 12 credits at 3:42pm" back to a specific call.
- `created_at` — timestamp.

For rate limiting, no Postgres table — the entire mechanism lives in Redis. Keys are shaped `ratelimit:<apiKeyId>:<minute-bucket>` where `minute-bucket` is the integer Unix minute (e.g. `29456789`). Values are the count for that minute. TTL is 60 seconds.

### Endpoints

No new public endpoints. Both systems are middleware on every authenticated request to `/v1/*`. The credit balance is exposed via `GET /me/subscription` (see billing) and the audit log via `GET /me/usage` (see usage analytics). Rate-limit state is exposed only through response headers, not a dedicated endpoint.

### Logic

**Pricing per request** is computed before any work happens, based on the eventual response shape:
- Cache hit (Redis or Postgres): **0 credits**. The customer pays nothing because we did nothing real.
- Native YouTube caption fetch (cache miss, captions exist): **1 credit** flat, regardless of video length.
- Whisper transcription fallback (cache miss, no native captions, audio transcribed): **ceil(durationMinutes)** credits. A 12-minute video is 12 credits, a 90-second video is 2 credits (ceil rounds up). This reflects the real underlying compute cost, which scales linearly with audio length.
- Translation surcharge: **+1 credit** added to whichever base cost above, if `translate_to` is requested and the target differs from the source. Flat regardless of segment count.

So a worst-case fresh-fetch-with-Whisper-and-translation request on a 30-minute video costs `30 + 1 = 31` credits.

**Deduction must be transactional.** Two requests racing to spend the customer's last few credits cannot both succeed. The deduction routine is a database transaction that:
1. Locks the user row for update (`SELECT ... FOR UPDATE`).
2. Reads the current `credit_balance`.
3. If balance is less than the cost, rolls back and throws a typed `PaymentRequiredError`.
4. Otherwise updates the balance to `balance - cost`, inserts a `credit_transactions` row with the delta and the new balance, and commits.

The `FOR UPDATE` lock is what makes this safe under concurrency — two concurrent transactions for the same user are serialized at the row level, so one will see the other's deduction before computing its own balance check. Without this, both might see balance 5 against a cost of 3, both deduct, and the user ends up at -1 credits.

**402 on insufficient balance.** When `PaymentRequiredError` is thrown, the request handler catches it and returns HTTP 402 Payment Required with a JSON body containing `error: { code: 'PAYMENT_REQUIRED', message: 'Insufficient credits', balance: <currentBalance>, cost: <requestedCost> }`. The response also includes the X-RateLimit headers like any other response, because rate limiting still applies on the error path. The customer's dashboard surfaces this as a banner with an upgrade CTA.

**Cache hits skip deduction entirely.** The credit-charging middleware runs after the cache check, not before. If the cache returns a hit, the cost is 0 and we don't even enter the deduction transaction. This keeps cached responses both free and fast (no DB write).

**Audit log is forensic, not authoritative.** The single source of truth for "how many credits does this user have" is `users.credit_balance`. The `credit_transactions` table exists so that support can answer "what happened" — every deduction, every grant from a billing webhook, every manual adjustment writes a row. If the audit log and the balance ever disagree, the balance wins; the log might have a missing row from a partial transaction, but the balance is what was actually committed.

**Rate limiting** is a Redis token-bucket per API key, with 1-minute granularity:
1. On every authenticated request, identify the API key, derive the current minute bucket, and form the Redis key `ratelimit:<apiKeyId>:<minute>`.
2. Atomically: set the key to 1 with `EX 60 NX` (only if it doesn't exist), then INCR it. The two operations together give us "create if missing with TTL, then increment" without a race.
3. Read the resulting count. Compare to the per-plan limit. If over, return 429 Too Many Requests with a `Retry-After` header set to the seconds remaining in the current minute.
4. On every response (success, 4xx, or 5xx), set three headers:
   - `X-RateLimit-Limit`: the plan's per-minute cap (10, 60, 100, 300).
   - `X-RateLimit-Remaining`: the cap minus the current count, floored at 0.
   - `X-RateLimit-Reset`: a Unix timestamp at the start of the next minute.

These headers follow the de facto convention used by GitHub, Stripe, and others, so client libraries that already understand the convention work out of the box.

**Failure modes.**
- If Redis is unreachable during the rate-limit check, **fail open** — let the request through with the headers omitted. Rate limiting is best-effort protection, not a billing-critical path; degrading availability when the throttle layer wobbles would be worse than letting some requests slip.
- If Postgres is unreachable during the credit deduction, **fail closed** — return a 503 with a generic message. We will not serve transcripts we cannot bill for.
- If the deduction transaction succeeds but the actual transcript fetch then fails (upstream YouTube error, Whisper crash), **refund** by inserting a compensating `credit_transactions` row with `delta=+cost`, `reason='request_failure_refund'`, and updating the balance back. The customer must not be charged for failures.

**Optional grace bucket.** Out of scope for MVP. The idea is that a user who has hit their monthly credit limit can be allowed up to ~5% extra usage before being hard-cut, so a customer who's slightly over on the last day of the month doesn't have a broken pipeline. Useful but not essential — call out as future work and revisit once we have real usage data.

## Frontend

The dashboard's main top bar shows the current credit balance and a small progress ring against the plan's monthly allotment, so a customer always knows where they stand. When the balance hits zero, the ring turns red and a banner appears across all dashboard pages with an upgrade CTA pointing at the billing page.

The 402 response shape is rendered by the dashboard's transcript viewer as a clear "Out of credits" empty state with the cost vs balance breakdown ("This request costs 12 credits but you have 3 remaining") and an upgrade button.

429 responses are rendered as a softer "Rate limit hit, retry in X seconds" toast with a countdown. The frontend does not auto-retry; the customer's own integration is responsible for that.

The usage page (see usage analytics) shows the credit transaction log filtered to the last 30 days with each row's reason, delta, and resulting balance, so a customer can do their own audit.

## Dependencies

Caching strategy must exist for the "0 credits on cache hit" rule to be meaningful — though the credits system itself can ship first with cost set to 1 for everything and be tightened up later. Translation surcharge depends on translation existing. Billing webhooks depend on this system existing because they grant credits on plan renewal.

## Verification

A free-plan user with 50 credits requesting a fresh native-caption transcript should drop to 49. The same request again (now cached) should leave them at 49 — no charge. A request for a 10-minute video with no native captions (Whisper path) should drop to 39.

A user with 3 credits requesting a Whisper transcript that would cost 12 should get a 402 with the breakdown in the body, and their balance should still be 3 (no partial deduction). The audit log should have no row for this attempt.

Two concurrent requests from the same user, each costing the user's last 5 credits, should result in exactly one success (-5, balance 0) and one 402, never both succeeding.

Hammering an API key with 11 requests in a single second on the free plan (limit 10/min) should produce 10 successes and one 429 with `Retry-After` set to a value less than 60. The successful responses should show `X-RateLimit-Remaining` decrementing from 9 to 0.

Force a Whisper failure mid-request (toggle a stub flag). The response should be a 5xx and the audit log should show both the deduction and the matching refund, with the user's balance restored.

A `curl -i "https://api.example.com/v1/transcript?url=..." -H "Authorization: Bearer $KEY"` should always show the three rate-limit headers in the response, regardless of status code.
