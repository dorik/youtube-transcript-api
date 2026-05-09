import { Router, raw } from 'express';
import type Stripe from 'stripe';
import { applyPlanUpgrade, verifyStripeWebhook, PlanId, PLANS } from '../services/stripeService';
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
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionEvent(event);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event);
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

async function handleSubscriptionEvent(event: Stripe.Event): Promise<void> {
  // For checkout.session.completed the object is a Session;
  // for customer.subscription.* it's a Subscription. We pull the metadata
  // off whichever is present.
  let userId: string | undefined;
  let plan: PlanId | undefined;
  let stripeCustomerId: string | undefined;
  let stripeSubscriptionId: string | undefined;

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    userId = session.metadata?.user_id;
    plan = session.metadata?.plan as PlanId | undefined;
    stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  } else {
    const sub = event.data.object as Stripe.Subscription;
    userId = sub.metadata?.user_id;
    plan = sub.metadata?.plan as PlanId | undefined;
    stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    stripeSubscriptionId = sub.id;
  }

  if (!userId || !plan || !PLANS[plan]) {
    logger.warn({ eventId: event.id, userId, plan }, 'Stripe event missing user_id/plan metadata');
    return;
  }

  await applyPlanUpgrade({
    userId,
    plan,
    stripeCustomerId,
    stripeSubscriptionId,
    stripeEventId: event.id,
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
