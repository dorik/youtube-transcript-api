import { Router, raw } from 'express';
import type Stripe from 'stripe';
import {
  applyPlanUpgrade,
  priceIdToPlanId,
  syncSubscriptionMeta,
  verifyStripeWebhook,
  PlanId,
  PLANS,
} from '../services/stripeService';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { pool } from '../db/pool';

export const webhooksRouter = Router();

/**
 * Stripe webhook handler. Mounted with `raw` body parser so signature
 * verification gets the exact bytes Stripe signed.
 *
 * In stub mode this responds 200 to keep platforms (Stripe CLI tests,
 * staging-hosted webhooks) from retrying, but does no work.
 *
 * ## Event routing
 *
 * - `checkout.session.completed`     → initial provisioning. The session
 *                                      metadata carries `user_id` + `plan`.
 * - `customer.subscription.updated`  → if the active price now maps to a
 *                                      different plan than what we have
 *                                      stored, apply the plan change.
 *                                      Otherwise just sync cycle/status.
 * - `customer.subscription.deleted`  → mark the row cancelled.
 * - `invoice.payment_succeeded`      → renewal. Refill credits on
 *                                      `subscription_cycle` only;
 *                                      `subscription_create` is already
 *                                      covered by checkout.session.completed,
 *                                      and `subscription_update` (proration)
 *                                      is handled by the subscription event.
 *
 * `customer.subscription.created` is intentionally NOT handled — every
 * subscription that lands here is also covered by
 * `checkout.session.completed` (which has the richer metadata), so doubling
 * up would only risk granting credits twice.
 */
webhooksRouter.post('/stripe', raw({ type: 'application/json' }), async (req, res) => {
  if (config.STUB_STRIPE) {
    logger.info('Stripe webhook received in stub mode; ignoring');
    return res.json({ received: true, mode: 'stub' });
  }

  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    return res.status(400).json({ error: 'missing stripe-signature' });
  }

  let event: Stripe.Event;
  try {
    event = verifyStripeWebhook(req.body as Buffer, signature);
  } catch (err) {
    logger.warn({ err }, 'Stripe webhook signature verification failed');
    return res.status(400).json({ error: 'invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event);
        break;
      default:
        logger.debug({ type: event.type }, 'Unhandled Stripe event type');
    }
    res.json({ received: true });
  } catch (err) {
    logger.error({ err, eventId: event.id }, 'Failed to process Stripe webhook');
    res.status(500).json({ error: 'webhook processing failed' });
  }
});

async function handleCheckoutCompleted(event: Stripe.Event): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  const userId = session.metadata?.user_id;
  const plan = session.metadata?.plan as PlanId | undefined;

  if (!userId || !plan || !PLANS[plan]) {
    logger.warn({ eventId: event.id, userId, plan }, 'checkout.session.completed missing metadata');
    return;
  }

  const stripeCustomerId =
    typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const stripeSubscriptionId =
    typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;

  // We don't have the real `current_period_end` on the session object
  // without an API retrieve; let the follow-up subscription/invoice events
  // refine `billing_cycle_end`. NOW()+30d is the safe fallback in the
  // meantime so paid features unlock immediately.
  await applyPlanUpgrade({
    userId,
    plan,
    stripeCustomerId,
    stripeSubscriptionId,
    stripeEventId: event.id,
  });
}

async function handleSubscriptionUpdated(event: Stripe.Event): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;

  const priceId = sub.items.data[0]?.price.id;
  if (!priceId) {
    logger.warn({ eventId: event.id, subId: sub.id }, 'subscription.updated has no price');
    return;
  }
  const stripePlan = priceIdToPlanId(priceId);
  if (!stripePlan) {
    logger.warn({ eventId: event.id, subId: sub.id, priceId }, 'subscription.updated has unrecognized price');
    return;
  }

  const { rows } = await pool.query<{ user_id: string; plan_id: PlanId }>(
    `SELECT user_id, plan_id FROM subscriptions WHERE stripe_subscription_id = $1`,
    [sub.id],
  );
  const stored = rows[0];
  if (!stored) {
    logger.warn({ eventId: event.id, subId: sub.id }, 'subscription.updated for unknown subscription');
    return;
  }

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000)
    : null;

  if (stored.plan_id === stripePlan) {
    // No plan change. Keep our cycle/status copy in sync but DON'T refill
    // credits — those come from `invoice.payment_succeeded`.
    await syncSubscriptionMeta({
      stripeSubscriptionId: sub.id,
      stripeCustomerId: customerId,
      currentPeriodEnd: periodEnd,
      status: sub.status,
    });
    return;
  }

  // Plan changed (upgrade/downgrade through the customer portal, etc.).
  // Refill to the new plan's allowance.
  await applyPlanUpgrade({
    userId: stored.user_id,
    plan: stripePlan,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    stripeEventId: event.id,
    currentPeriodEnd: periodEnd,
  });
}

async function handleSubscriptionDeleted(event: Stripe.Event): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;
  await pool.query(
    `UPDATE subscriptions
     SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
     WHERE stripe_subscription_id = $1`,
    [sub.id],
  );
  logger.info({ subscriptionId: sub.id }, 'Subscription marked cancelled');
}

async function handleInvoicePaymentSucceeded(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;

  // Only refill credits on regular monthly renewals. The first invoice
  // (subscription_create) is covered by checkout.session.completed, and
  // mid-cycle proration invoices (subscription_update) are covered by
  // customer.subscription.updated.
  if (invoice.billing_reason !== 'subscription_cycle') return;

  const subId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id;
  if (!subId) {
    logger.warn({ eventId: event.id }, 'invoice.payment_succeeded has no subscription id');
    return;
  }

  const { rows } = await pool.query<{ user_id: string; plan_id: PlanId }>(
    `SELECT user_id, plan_id FROM subscriptions WHERE stripe_subscription_id = $1`,
    [subId],
  );
  const stored = rows[0];
  if (!stored) {
    logger.warn({ eventId: event.id, subId }, 'invoice.payment_succeeded for unknown subscription');
    return;
  }

  const periodEnd = invoice.period_end ? new Date(invoice.period_end * 1000) : null;

  await applyPlanUpgrade({
    userId: stored.user_id,
    plan: stored.plan_id,
    stripeSubscriptionId: subId,
    stripeEventId: event.id,
    currentPeriodEnd: periodEnd,
  });
}
