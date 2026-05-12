import Stripe from 'stripe';
import {config} from '../config/env';
import {withTransaction, pool} from '../db/pool';
import {logger} from '../config/logger';

export type PlanId = 'free' | 'starter' | 'pro' | 'business';

export interface PlanConfig {
	id: PlanId;
	name: string;
	price: number; // dollars
	monthlyCredits: number;
	stripePriceEnvKey: keyof typeof config | null;
}

export const PLANS: Record<PlanId, PlanConfig> = {
	free: {
		id: 'free',
		name: 'Free',
		price: 0,
		monthlyCredits: 100,
		stripePriceEnvKey: null,
	},
	starter: {
		id: 'starter',
		name: 'Starter',
		price: 9,
		monthlyCredits: 2_500,
		stripePriceEnvKey: 'STRIPE_PRICE_ID_STARTER',
	},
	pro: {
		id: 'pro',
		name: 'Pro',
		price: 29,
		monthlyCredits: 12_000,
		stripePriceEnvKey: 'STRIPE_PRICE_ID_PRO',
	},
	business: {
		id: 'business',
		name: 'Business',
		price: 79,
		monthlyCredits: 40_000,
		stripePriceEnvKey: 'STRIPE_PRICE_ID_BUSINESS',
	},
};

/**
 * Reverse-map a Stripe price ID back to one of our PlanIds.
 *
 * `customer.subscription.updated` events expose the active price by ID, not
 * by plan name. To detect a plan change we need to translate that price back
 * to our internal taxonomy. Returns `null` if the price isn't one we
 * configured (e.g. a leftover test price from before this code was
 * deployed).
 */
export function priceIdToPlanId(priceId: string): PlanId | null {
	for (const plan of Object.values(PLANS)) {
		if (!plan.stripePriceEnvKey) continue;
		const configured = config[plan.stripePriceEnvKey];
		if (configured === priceId) return plan.id;
	}
	return null;
}

/**
 * True for any plan that's paid (i.e. NOT 'free').
 *
 * Used to gate features that cost real money on our side — most notably
 * the OpenAI Whisper transcription path. Free users get the canned stub
 * response instead, so we don't burn OpenAI quota on accounts that
 * haven't paid anything.
 *
 * `undefined` / `null` (no subscription row at all) is treated as free —
 * a fresh user gets a row on signup, but we shouldn't blow up if the
 * subscription record is missing for any reason.
 */
export function isPaidPlan(planId: PlanId | null | undefined): boolean {
	if (!planId) return false;
	return planId !== 'free';
}

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
	if (config.STUB_STRIPE) {
		throw new Error(
			'Stripe is stubbed; getStripe() should not be called when STUB_STRIPE=true',
		);
	}
	if (!config.STRIPE_SECRET_KEY) {
		throw new Error('STRIPE_SECRET_KEY is required when STUB_STRIPE=false');
	}
	if (!stripeClient) {
		// Pin to whatever the installed SDK declares as latest. We cast because
		// the literal version moves with package upgrades; we don't want a
		// stripe@major bump to be a code-edit story.
		stripeClient = new Stripe(config.STRIPE_SECRET_KEY);
	}
	return stripeClient;
}

/**
 * Look up the Stripe customer ID we've previously associated with this user,
 * so re-checkouts re-use it instead of minting a fresh Customer each time.
 *
 * Returns `null` if the user has never been billed (no row, or row exists
 * but `stripe_customer_id` is still null — e.g. a stub-mode user who never
 * went through real checkout).
 */
async function getStoredStripeCustomerId(
	userId: string,
): Promise<string | null> {
	const {rows} = await pool.query<{stripe_customer_id: string | null}>(
		`SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1 LIMIT 1`,
		[userId],
	);
	return rows[0]?.stripe_customer_id ?? null;
}

/**
 * Read everything we need to decide whether a "switch plans" request should
 * go through a new Checkout Session (first-time signup, or post-cancel
 * re-signup) or update the existing subscription in place.
 */
async function getStoredSubscription(userId: string): Promise<{
	planId: PlanId | null;
	stripeSubscriptionId: string | null;
	status: string | null;
} | null> {
	const {rows} = await pool.query<{
		plan_id: PlanId | null;
		stripe_subscription_id: string | null;
		status: string | null;
	}>(
		`SELECT plan_id, stripe_subscription_id, status FROM subscriptions WHERE user_id = $1 LIMIT 1`,
		[userId],
	);
	if (!rows[0]) return null;
	return {
		planId: rows[0].plan_id,
		stripeSubscriptionId: rows[0].stripe_subscription_id,
		status: rows[0].status,
	};
}

/**
 * Swap the price on an existing Stripe Subscription instead of minting a
 * brand-new one through Checkout.
 *
 * This is THE plan-change path for any user who already has an active
 * subscription. The previous code always went through Checkout, which
 * (a) charged the customer's card *again* immediately and
 * (b) left the original subscription active — so the customer would be
 * billed twice forever.
 *
 * Stripe defaults `proration_behavior` to `create_prorations`, which:
 *   - issues a credit line item for the unused portion of the old plan,
 *   - issues a charge line item for the new plan's prorated cost,
 *   - nets them out on the *next* invoice (no immediate card charge).
 *
 * The customer.subscription.updated webhook fires right after this call;
 * our handler (handleSubscriptionUpdated) turns that into an
 * applyPlanUpgrade that updates our DB and refills credits. So we do NOT
 * touch our DB here — webhook stays the single source of truth and we
 * avoid double-allocating credits.
 */
async function updateSubscriptionPlan(opts: {
	userId: string;
	stripeSubscriptionId: string;
	plan: PlanId;
}): Promise<void> {
	if (opts.plan === 'free') {
		throw new Error(
			'Cannot switch to Free via plan update; cancel the subscription instead',
		);
	}
	const planConfig = PLANS[opts.plan];
	const priceId = config[planConfig.stripePriceEnvKey!] as string | undefined;
	if (!priceId) {
		throw new Error(
			`Stripe price ID is not configured for plan ${opts.plan}`,
		);
	}
	const stripe = getStripe();
	// Need the existing item ID to swap its price; Stripe rejects updates
	// that just specify a new price without saying which line item to mutate.
	const current = await stripe.subscriptions.retrieve(
		opts.stripeSubscriptionId,
	);
	const currentItemId = current.items.data[0]?.id;
	if (!currentItemId) {
		throw new Error(
			`Subscription ${opts.stripeSubscriptionId} has no items to update`,
		);
	}
	await stripe.subscriptions.update(opts.stripeSubscriptionId, {
		items: [{id: currentItemId, price: priceId}],
		proration_behavior: 'create_prorations',
		metadata: {user_id: opts.userId, plan: opts.plan},
	});
}

export type ChangePlanOutcome =
	| {status: 'noop'; reason: 'already_on_plan'}
	| {status: 'no_subscription'} // caller should redirect to checkout
	| {status: 'changed'; mode: 'stub' | 'live'};

/**
 * Switch an existing subscription to a different paid plan.
 *
 * Returns a discriminated union so the route can translate "no active
 * subscription" into a clean 4xx telling the frontend to go through
 * /billing/checkout instead. Doing the dispatch here instead of in the
 * route keeps the Stripe details out of the HTTP layer.
 *
 * Live mode mutates the Stripe Subscription's price item with prorations
 * (no immediate charge — proration nets out on the next invoice). The
 * customer.subscription.updated webhook then syncs our DB. We deliberately
 * don't touch our DB here so the webhook stays the single source of truth
 * and credits aren't refilled twice.
 *
 * Stub mode short-circuits straight to applyPlanUpgrade so dev/QA workflows
 * don't need Stripe configured.
 */
export async function changeSubscriptionPlan(opts: {
	userId: string;
	plan: PlanId;
}): Promise<ChangePlanOutcome> {
	if (opts.plan === 'free') {
		throw new Error(
			'Cannot switch to Free via change-plan; cancel the subscription instead',
		);
	}

	const stored = await getStoredSubscription(opts.userId);
	const hasActive =
		stored?.status === 'active' && !!stored.stripeSubscriptionId;

	if (!hasActive) {
		return {status: 'no_subscription'};
	}

	if (stored?.planId === opts.plan) {
		return {status: 'noop', reason: 'already_on_plan'};
	}

	if (config.STUB_STRIPE) {
		// No Stripe round-trip; flip the plan locally just like stub-activate.
		await applyPlanUpgrade({
			userId: opts.userId,
			plan: opts.plan,
			stripeEventId: `stub_change_${opts.userId}_${opts.plan}_${Date.now()}`,
		});
		return {status: 'changed', mode: 'stub'};
	}

	await updateSubscriptionPlan({
		userId: opts.userId,
		stripeSubscriptionId: stored!.stripeSubscriptionId!,
		plan: opts.plan,
	});
	return {status: 'changed', mode: 'live'};
}

/**
 * Create a checkout session and return the URL the user should be redirected
 * to. In stub mode we return a frontend route that the dashboard treats as a
 * "stub success" — clicking it activates the upgrade locally.
 *
 * This is for FIRST-TIME paid signups only (free → paid, or post-cancel
 * re-signup). For an existing active subscriber switching plans, use
 * `changeSubscriptionPlan` — going through Checkout for those users
 * creates a second active subscription and double-bills them.
 */
export async function createCheckoutSession(opts: {
	userId: string;
	email: string;
	plan: PlanId;
}): Promise<{url: string; mode: 'stub' | 'live'}> {
	if (opts.plan === 'free') {
		throw new Error('Cannot create a checkout session for the Free plan');
	}
	const planConfig = PLANS[opts.plan];

	if (config.STUB_STRIPE) {
		return {
			mode: 'stub',
			url: `${config.FRONTEND_URL}/dashboard/billing?stub_success=1&plan=${opts.plan}`,
		};
	}

	const stripe = getStripe();
	const priceId = config[planConfig.stripePriceEnvKey!] as string | undefined;
	if (!priceId) {
		throw new Error(
			`Stripe price ID is not configured for plan ${opts.plan}`,
		);
	}

	// Re-use the existing Stripe Customer when we already have one so that a
	// user upgrading/downgrading doesn't end up with a fan of disconnected
	// Customer rows in the Stripe dashboard.
	const existingCustomerId = await getStoredStripeCustomerId(opts.userId);

	const session = await stripe.checkout.sessions.create({
		mode: 'subscription',
		...(existingCustomerId
			? {customer: existingCustomerId}
			: {customer_email: opts.email}),
		line_items: [{price: priceId, quantity: 1}],
		success_url: `${config.FRONTEND_URL}/dashboard/billing?session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${config.FRONTEND_URL}/dashboard/billing?cancelled=1`,
		metadata: {user_id: opts.userId, plan: opts.plan},
		// Stripe does NOT propagate session metadata to the subscription
		// automatically. Without `subscription_data.metadata`, the
		// `customer.subscription.{created,updated}` events would arrive with
		// empty metadata and our webhook handler would have no way to resolve
		// them back to a user. See:
		// https://stripe.com/docs/payments/checkout/subscriptions#pass-subscription-metadata
		subscription_data: {metadata: {user_id: opts.userId, plan: opts.plan}},
	});

	return {mode: 'live', url: session.url ?? ''};
}

/**
 * Apply an upgrade. Used by both the stub success endpoint and real Stripe
 * webhook handlers. Idempotent on `subscriptions.user_id` — calling twice
 * for the same plan is safe.
 *
 * `currentPeriodEnd` is the cycle end from Stripe (preferred). When absent
 * we fall back to NOW()+30d, which is what the stub path uses.
 */
export async function applyPlanUpgrade(opts: {
	userId: string;
	plan: PlanId;
	stripeCustomerId?: string | null;
	stripeSubscriptionId?: string | null;
	stripeEventId?: string | null;
	currentPeriodEnd?: Date | null;
}): Promise<void> {
	const planConfig = PLANS[opts.plan];
	if (planConfig.id === 'free') {
		// No-op: downgrades happen elsewhere
		return;
	}

	const cycleEnd =
		opts.currentPeriodEnd ??
		new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

	await withTransaction(async (client) => {
		// Upsert subscription
		await client.query(
			`INSERT INTO subscriptions
        (user_id, plan_id, plan_name, monthly_credits, billing_cycle_start, billing_cycle_end,
         stripe_customer_id, stripe_subscription_id, status)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, 'active')
       ON CONFLICT (user_id) DO UPDATE
         SET plan_id = EXCLUDED.plan_id,
             plan_name = EXCLUDED.plan_name,
             monthly_credits = EXCLUDED.monthly_credits,
             billing_cycle_start = EXCLUDED.billing_cycle_start,
             billing_cycle_end = EXCLUDED.billing_cycle_end,
             stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
             stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id),
             status = 'active',
             updated_at = NOW()`,
			[
				opts.userId,
				planConfig.id,
				planConfig.name,
				planConfig.monthlyCredits,
				cycleEnd,
				opts.stripeCustomerId ?? null,
				opts.stripeSubscriptionId ?? null,
			],
		);

		// Reset balance to the plan allowance (additive `total_allocated` for
		// lifetime tracking).
		await client.query(
			`UPDATE credits
       SET balance = $1,
           total_allocated = total_allocated + $1,
           last_reset_at = NOW(),
           next_reset_at = $2,
           updated_at = NOW()
       WHERE user_id = $3`,
			[planConfig.monthlyCredits, cycleEnd, opts.userId],
		);

		if (opts.stripeEventId) {
			await client.query(
				`INSERT INTO billing_events
          (user_id, stripe_event_id, event_type, stripe_customer_id, stripe_subscription_id,
           credits_issued, status, processed, processed_at)
         VALUES ($1, $2, 'subscription.upserted', $3, $4, $5, 'succeeded', TRUE, NOW())
         ON CONFLICT (stripe_event_id) DO NOTHING`,
				[
					opts.userId,
					opts.stripeEventId,
					opts.stripeCustomerId ?? null,
					opts.stripeSubscriptionId ?? null,
					planConfig.monthlyCredits,
				],
			);
		}
	});

	logger.info(
		{
			userId: opts.userId,
			plan: opts.plan,
			credits: planConfig.monthlyCredits,
		},
		'Plan upgrade applied',
	);
}

/**
 * Push the latest cycle end / customer ID / status from Stripe onto our
 * stored subscription row without touching plan or credits.
 *
 * `customer.subscription.updated` fires for many reasons (card update,
 * dunning, scheduled cancel, etc.) — when nothing about the plan itself has
 * changed we still want to keep our copy of the cycle window and status in
 * sync, but we MUST NOT refill credits each time. That's what this does.
 */
export async function syncSubscriptionMeta(opts: {
	stripeSubscriptionId: string;
	stripeCustomerId?: string | null;
	currentPeriodEnd?: Date | null;
	status?: string | null;
}): Promise<void> {
	await pool.query(
		`UPDATE subscriptions
     SET stripe_customer_id = COALESCE($2, stripe_customer_id),
         billing_cycle_end  = COALESCE($3, billing_cycle_end),
         status             = COALESCE($4, status),
         updated_at         = NOW()
     WHERE stripe_subscription_id = $1`,
		[
			opts.stripeSubscriptionId,
			opts.stripeCustomerId ?? null,
			opts.currentPeriodEnd ?? null,
			opts.status ?? null,
		],
	);
}

/**
 * Verify and parse a Stripe webhook payload. Returns the event when valid.
 */
export function verifyStripeWebhook(
	rawBody: Buffer,
	signature: string,
): Stripe.Event {
	if (config.STUB_STRIPE) {
		throw new Error(
			'Webhooks should not be reaching this code path in stub mode',
		);
	}
	if (!config.STRIPE_WEBHOOK_SECRET) {
		throw new Error(
			'STRIPE_WEBHOOK_SECRET is required to verify Stripe webhooks',
		);
	}
	const stripe = getStripe();
	return stripe.webhooks.constructEvent(
		rawBody,
		signature,
		config.STRIPE_WEBHOOK_SECRET,
	);
}

export interface SubscriptionView {
	plan_id: PlanId;
	plan_name: string;
	monthly_credits: number;
	status: string;
	billing_cycle_start: Date;
	billing_cycle_end: Date;
	cancelled_at: Date | null;
}

export async function getUserSubscription(
	userId: string,
): Promise<SubscriptionView | null> {
	const {rows} = await pool.query<SubscriptionView>(
		`SELECT plan_id, plan_name, monthly_credits, status,
            billing_cycle_start, billing_cycle_end, cancelled_at
     FROM subscriptions WHERE user_id = $1`,
		[userId],
	);
	return rows[0] ?? null;
}
