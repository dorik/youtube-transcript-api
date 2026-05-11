# Billing and Subscriptions

## What this is

This is how the YouTube Transcripts API gets paid. Customers land on a pricing page, pick a plan, check out through Stripe, and on a successful payment their account flips from Free to whatever they bought, with their monthly credit allotment refilled and their per-minute rate limit raised. On the first of every billing cycle Stripe charges them again, our webhook handler sees the renewal, and we top their credit balance back up. If they cancel, they keep their paid features until the end of the period and then drop to Free. If they upgrade mid-cycle, Stripe handles the prorated charge and we lift their plan immediately.

Stripe is the system of record for everything that involves money. We do not store card numbers, do not compute prorations, do not handle dunning, and do not chase failed payments — Stripe does all of that and tells us the outcome via webhooks. Our database mirrors only what we need to enforce in our own code: the customer's current plan, their credit balance, and the period end date for "renews on" copy.

The whole billing surface is stub-aware. In development we run with `STUB_STRIPE=true` (the default) and the system pretends Stripe exists — checkout returns a fake URL that loops back to a local-only `/billing/stub-activate` endpoint, which flips the user's plan immediately. This means a developer can build and test the full upgrade flow with no Stripe account, no test mode keys, no webhook tunneling. In production `STUB_STRIPE=false` and everything goes through real Stripe with real signatures.

The plan catalog (Free, Starter, Pro, Business with their credit allotments and rate limits) lives as a single constant in the backend, and is exposed via a public `GET /plans` endpoint that the pricing page and the dashboard both consume. There is exactly one source of truth for plan definitions.

## UI/interaction idea

The pricing page shows four cards side by side — Free, Starter, Pro, Business — with credits per month, requests per minute, and price prominently. The user's current plan (if logged in) gets a "Current plan" badge instead of a CTA button; the others get either "Upgrade" or "Downgrade" buttons. Clicking either fires a server call to `/billing/checkout`, which returns a URL, and the browser redirects there.

After Stripe checkout completes the user lands back on `/dashboard/billing` with a success banner ("Welcome to Pro! Your credit balance has been refilled to 10,000.") and the page shows the new plan, the new balance, the renewal date, and a list of recent invoices.

The dashboard billing page also has a "Manage subscription" button that links to the Stripe Customer Portal, which is where cancellation, payment-method changes, and invoice downloads live. We deliberately do not build our own UI for those — Stripe's portal is good and free.

In stub mode the success path is identical from the user's perspective except that the redirect goes to `/dashboard/billing?stub_success=1&plan=pro`, and the page detects the query param, calls `/billing/stub-activate` to flip the local user record, and shows the same success banner. This keeps the dev experience indistinguishable from prod.

## Backend

### Schema

Add three pieces to existing tables and create one new table.

On `users`:
- `plan` — text enum (`free`, `starter`, `pro`, `business`). Default `free`. Updated by webhooks (or by `stub-activate` in dev).
- `stripe_customer_id` — nullable text. Set on the first checkout, reused thereafter.
- `stripe_subscription_id` — nullable text. The active subscription's ID, used to look up state from the Stripe API when needed.
- `current_period_end` — nullable timestamp. The end of the current paid period; null for Free users.

A new `webhook_events` table for idempotency:
- `stripe_event_id` — text, primary key. The Stripe-provided event ID.
- `type` — text, the Stripe event type for debugging.
- `payload` — JSONB, the full event for forensics.
- `received_at` — timestamp.

Existing `credit_transactions` (defined in credits-and-rate-limiting) gets used by the billing webhooks — every plan renewal writes a `delta=+allotment, reason='plan_renewal'` row, every upgrade writes a `delta=+(newAllotment - oldAllotment), reason='plan_upgrade_grant'` row.

The plan catalog itself is a code constant, not a table. It maps each plan name to its monthly credit allotment, per-minute rate limit, monthly USD price, and the corresponding `STRIPE_PRICE_ID_<plan>` environment variable. Centralizing it as code (rather than DB rows) means a plan price change ships as a normal deploy and is reviewable in a PR.

### Endpoints

- `GET /plans` — public, no auth. Returns the catalog: an array of plans with name, credits, rate limit, price, and a list of feature bullets. Used by both the marketing pricing page and the dashboard.
- `POST /billing/checkout` — authenticated. Body `{ plan }`. In real mode, creates a Stripe Checkout Session with the matching `STRIPE_PRICE_ID_<plan>`, the customer's `stripe_customer_id` (creating a new Stripe customer if they don't have one yet), success and cancel URLs pointing back at the dashboard, and returns `{ url }`. In stub mode, returns a fake `{ url: '/dashboard/billing?stub_success=1&plan=<plan>' }`.
- `POST /billing/stub-activate` — authenticated, **dev-only** (gated on `STUB_STRIPE=true`, returns 404 in prod). Body `{ plan }`. Flips the user's plan immediately, sets `current_period_end` to one month from now, and grants the plan's credit allotment via a `credit_transactions` row. This is the local-only shortcut that mimics what a real Stripe webhook would do.
- `POST /webhooks/stripe` — public, no auth (signature-verified instead). Receives Stripe webhook events. Must be wired with raw-body parsing because the signature check is over the raw bytes, not the parsed JSON. Verifies the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET`, looks up the event ID in `webhook_events`, and either skips (already processed) or processes and inserts.
- `POST /billing/portal` — authenticated. Creates a Stripe Customer Portal session for the user's customer ID and returns the URL. Frontend redirects there for cancellation, payment method updates, invoice downloads.
- `GET /me/subscription` — authenticated. Returns the user's current plan, credit balance, current period end, and a `cancelAtPeriodEnd` boolean (read from Stripe via the stored subscription ID, or false for stub-mode users). This is what the dashboard billing page reads.

### Logic

**Checkout creation.** On `POST /billing/checkout`, look up the requested plan in the catalog. If the user has no `stripe_customer_id`, create a Stripe customer first using their email and store the returned ID. Then create a Checkout Session with mode `subscription`, the matching price ID, the customer ID, and success/cancel URLs that come back to `/dashboard/billing` with a `session_id` query parameter. Return the URL. The actual plan flip does not happen here — it happens when the webhook fires.

**Stub checkout.** When `STUB_STRIPE=true`, the same endpoint returns a fake URL pointing at the dashboard with `stub_success=1` and the plan name in the query string. The dashboard, on detecting that query param, calls `/billing/stub-activate` to do the actual flip. The `stub-activate` endpoint exists only in stub mode — in prod it returns a 404, so it cannot be used to grant free upgrades on real customers.

**Webhook handling.** The four Stripe events we care about:

1. **`checkout.session.completed`** — fired when a customer first subscribes. Pull the subscription ID from the event, look up the matching plan from the price ID (using the `STRIPE_PRICE_ID_<plan>` mapping in reverse), set the user's `plan` to that, set `stripe_subscription_id`, set `current_period_end` to the subscription's period end, and grant the full credit allotment with a `credit_transactions` row reasoned `plan_upgrade_grant`. Reset their balance to the new allotment (don't add — set, so they don't accumulate from any leftover Free credits).

2. **`customer.subscription.updated`** — fired on plan changes. Look up the new price ID, map to plan, update the user's `plan`. If the new plan is higher than the old plan, grant the difference in credits (so an upgrade mid-month immediately gives more). If lower, do not deduct credits — they keep what they have. Update `current_period_end`. Also pick up `cancel_at_period_end` here so the dashboard can show "Cancels on <date>" for cancellation-pending users.

3. **`customer.subscription.deleted`** — fired when a subscription actually ends (after cancel_at_period_end has elapsed, or on a hard cancel). Set the user's plan to `free`, clear `stripe_subscription_id`, set `current_period_end` to null. Do not refill credits — Free users have whatever they had left, capped at 50 going forward.

4. **`invoice.payment_succeeded`** — fired monthly on renewal. Set the user's `credit_balance` to the plan's monthly allotment (a hard set, not an add — unused credits don't roll over), update `current_period_end` to the new period end, and write a `credit_transactions` row with the reset.

**Idempotency.** Every webhook handler's first action is to insert into `webhook_events` keyed on the Stripe event ID. If the insert fails on the unique constraint, we have already processed this event — return 200 and stop. This protects against Stripe's at-least-once delivery and against double-processing during deploys.

**Signature verification.** Stripe's webhook signature is computed over the raw request body, not the parsed JSON. Express must be configured with raw-body parsing on the `/webhooks/stripe` route only (other routes still use JSON parsing). The verification uses `stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret)`. A failed verification returns 400 immediately and the event is not processed.

**Plan downgrade timing.** When a user clicks "Downgrade to Free" or "Downgrade to Starter", we do *not* immediately drop their plan — Stripe is configured to set `cancel_at_period_end: true` (or to switch the subscription to the lower tier at period end). The user keeps their current features and credit limits until the period ends, at which point the `customer.subscription.deleted` (or `customer.subscription.updated`) webhook fires and we flip them. The dashboard shows "Downgrades to Free on <date>" so this is transparent.

**Manual cancellation.** Users cancel through the Stripe Customer Portal, not through our UI. The portal sets the same `cancel_at_period_end` flag and Stripe fires the same webhooks. We don't need a custom cancel endpoint.

**The catalog as single source of truth.** The plan catalog object is imported by `GET /plans`, by the rate-limit middleware (to look up requests/minute), by the credit-deduction logic (for refill amounts), and by the webhook handler (for grant amounts). Changing a plan's credit allotment is a one-line edit to the catalog and a deploy.

## Frontend

Three pages.

The **public pricing page** at `/pricing` reads `GET /plans` and renders the four cards. For unauthenticated visitors, the CTAs are "Sign up" buttons. For authenticated visitors, the CTAs are "Upgrade", "Downgrade", or "Current plan" depending on their current `plan`.

The **dashboard billing page** at `/dashboard/billing` shows the user's current plan, credit balance, renewal date, a "Manage subscription" button (linking to the Stripe Portal), and a list of recent invoices fetched from Stripe via the portal link (we don't render invoices ourselves). Below that, the same plan cards as the pricing page so a user can upgrade/downgrade in place. On `?stub_success=1` it triggers the `stub-activate` flow and shows the success banner.

The **dashboard top bar** shows current plan and credit balance everywhere, not just on the billing page.

## Dependencies

Credits and rate limiting must exist — billing's whole job is to grant credits and to set the plan that the rate-limit middleware reads. The plan catalog is shared between billing, credits, and rate limiting.

## Verification

In stub mode (`STUB_STRIPE=true`), a free user clicking "Upgrade to Pro" on the pricing page should land on `/dashboard/billing?stub_success=1&plan=pro`, which calls `stub-activate`, which flips their plan to Pro, refills their credit balance to 10,000, and shows the success banner. `GET /me/subscription` should return `plan: pro, balance: 10000`.

A signed test webhook from `stripe listen` (e.g. `stripe trigger checkout.session.completed` with a custom price ID) hitting `/webhooks/stripe` should be accepted (signature verified), insert into `webhook_events`, flip the user's plan, and grant credits. Re-firing the same event should be a no-op (already in `webhook_events`).

`stripe trigger invoice.payment_succeeded` against a Pro user with 234 credits remaining should reset their balance to 10,000 (not add — set), update `current_period_end`, and write a `plan_renewal` audit row.

`stripe trigger customer.subscription.deleted` should drop the user back to Free, set `stripe_subscription_id` to null, and leave their existing balance alone.

A `curl https://api.example.com/plans` should return the catalog as JSON.

Hitting `POST /billing/stub-activate` in production should return 404 — verify by setting `STUB_STRIPE=false` locally and confirming the route is gone.

A webhook request with a wrong signature should return 400 and not modify any user record.
