import Stripe from 'stripe';
import { config } from '../config/env';
import { withTransaction, pool } from '../db/pool';
import { logger } from '../config/logger';

export type PlanId = 'free' | 'starter' | 'pro' | 'business';

export interface PlanConfig {
  id: PlanId;
  name: string;
  price: number; // dollars
  monthlyCredits: number;
  stripePriceEnvKey: keyof typeof config | null;
}

export const PLANS: Record<PlanId, PlanConfig> = {
  free: { id: 'free', name: 'Free', price: 0, monthlyCredits: 100, stripePriceEnvKey: null },
  starter: { id: 'starter', name: 'Starter', price: 9, monthlyCredits: 2_500, stripePriceEnvKey: 'STRIPE_PRICE_ID_STARTER' },
  pro: { id: 'pro', name: 'Pro', price: 29, monthlyCredits: 12_000, stripePriceEnvKey: 'STRIPE_PRICE_ID_PRO' },
  business: { id: 'business', name: 'Business', price: 79, monthlyCredits: 40_000, stripePriceEnvKey: 'STRIPE_PRICE_ID_BUSINESS' },
};

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (config.STUB_STRIPE) {
    throw new Error('Stripe is stubbed; getStripe() should not be called when STUB_STRIPE=true');
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
 * Create a checkout session and return the URL the user should be redirected
 * to. In stub mode we return a frontend route that the dashboard treats as a
 * "stub success" — clicking it activates the upgrade locally.
 */
export async function createCheckoutSession(opts: {
  userId: string;
  email: string;
  plan: PlanId;
}): Promise<{ url: string; mode: 'stub' | 'live' }> {
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
    throw new Error(`Stripe price ID is not configured for plan ${opts.plan}`);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: opts.email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${config.FRONTEND_URL}/dashboard/billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.FRONTEND_URL}/dashboard/billing?cancelled=1`,
    metadata: { user_id: opts.userId, plan: opts.plan },
  });

  return { mode: 'live', url: session.url ?? '' };
}

/**
 * Apply an upgrade. Used by both the stub success endpoint and real Stripe
 * webhook handlers. Idempotent on `subscriptions.user_id` — calling twice
 * for the same plan is safe.
 */
export async function applyPlanUpgrade(opts: {
  userId: string;
  plan: PlanId;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeEventId?: string | null;
}): Promise<void> {
  const planConfig = PLANS[opts.plan];
  if (planConfig.id === 'free') {
    // No-op: downgrades happen elsewhere
    return;
  }

  const cycleEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

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
    { userId: opts.userId, plan: opts.plan, credits: planConfig.monthlyCredits },
    'Plan upgrade applied',
  );
}

/**
 * Verify and parse a Stripe webhook payload. Returns the event when valid.
 */
export function verifyStripeWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  if (config.STUB_STRIPE) {
    throw new Error('Webhooks should not be reaching this code path in stub mode');
  }
  if (!config.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is required to verify Stripe webhooks');
  }
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
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

export async function getUserSubscription(userId: string): Promise<SubscriptionView | null> {
  const { rows } = await pool.query<SubscriptionView>(
    `SELECT plan_id, plan_name, monthly_credits, status,
            billing_cycle_start, billing_cycle_end, cancelled_at
     FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}
