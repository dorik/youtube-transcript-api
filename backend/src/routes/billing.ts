import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../middleware/sessionAuth';
import {
  PLANS,
  PlanId,
  applyPlanUpgrade,
  changeSubscriptionPlan,
  createCheckoutSession,
  getUserSubscription,
} from '../services/stripeService';
import { getCreditState } from '../services/creditService';
import { config } from '../config/env';
import { ValidationError } from '../utils/errors';

/**
 * Mounted under `/billing` (see app.ts). Every path here is billing-domain
 * by definition, so we don't repeat `/billing` in the path strings.
 */
export const billingRouter = Router();

billingRouter.get('/plans', (_req, res) => {
  // Public endpoint: lets the pricing page hydrate from a single source of
  // truth instead of duplicating numbers in the frontend.
  res.json({
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      price_usd: p.price,
      monthly_credits: p.monthlyCredits,
    })),
  });
});

billingRouter.get('/subscription', sessionAuth, async (req, res, next) => {
  try {
    const [sub, credits] = await Promise.all([
      getUserSubscription(req.user!.id),
      getCreditState(req.user!.id),
    ]);
    res.json({ subscription: sub, credits });
  } catch (err) {
    next(err);
  }
});

const CheckoutSchema = z.object({
  plan: z.enum(['starter', 'pro', 'business']),
});

billingRouter.post('/checkout', sessionAuth, async (req, res, next) => {
  try {
    const parsed = CheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid plan', { issues: parsed.error.flatten().fieldErrors });
    }
    const { url, mode } = await createCheckoutSession({
      userId: req.user!.id,
      email: req.user!.email,
      plan: parsed.data.plan,
    });
    res.json({ url, mode });
  } catch (err) {
    next(err);
  }
});

/**
 * Switch the plan on an existing subscription. Use this — NOT /checkout —
 * for upgrades/downgrades; /checkout would mint a second Stripe Subscription
 * and double-bill the customer.
 *
 * Returns:
 *   200 {status:'changed', mode}        — Stripe (or stub) accepted the plan switch.
 *                                          Webhook will refill credits / update DB.
 *   200 {status:'noop'}                  — User is already on this plan.
 *   409 {code:'NO_ACTIVE_SUBSCRIPTION'}  — User has no active subscription;
 *                                          frontend should hit /checkout instead.
 */
const ChangePlanSchema = z.object({
  plan: z.enum(['starter', 'pro', 'business']),
});

billingRouter.post('/change-plan', sessionAuth, async (req, res, next) => {
  try {
    const parsed = ChangePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid plan', { issues: parsed.error.flatten().fieldErrors });
    }
    const outcome = await changeSubscriptionPlan({
      userId: req.user!.id,
      plan: parsed.data.plan,
    });
    if (outcome.status === 'no_subscription') {
      return res.status(409).json({
        error: 'no_active_subscription',
        code: 'NO_ACTIVE_SUBSCRIPTION',
        message: 'No active subscription to change. Start a new checkout instead.',
      });
    }
    if (outcome.status === 'noop') {
      return res.json({ status: 'noop' });
    }
    res.json({ status: 'changed', mode: outcome.mode });
  } catch (err) {
    next(err);
  }
});

/**
 * Stub-only endpoint: the dashboard's "billing success" page calls this when
 * `stub_success=1` is in the URL. It mirrors what a real Stripe webhook
 * would do — flip the user to the chosen plan.
 *
 * In live mode (STUB_STRIPE=false) this is a no-op so nobody can self-grant
 * a Pro plan.
 */
const StubActivateSchema = z.object({
  plan: z.enum(['starter', 'pro', 'business']),
});

billingRouter.post('/stub-activate', sessionAuth, async (req, res, next) => {
  try {
    if (!config.STUB_STRIPE) {
      return res.status(404).json({ error: 'not_found', code: 'NOT_AVAILABLE', message: 'Stub activation is disabled in production billing mode.' });
    }
    const parsed = StubActivateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid plan', { issues: parsed.error.flatten().fieldErrors });
    }
    await applyPlanUpgrade({
      userId: req.user!.id,
      plan: parsed.data.plan as PlanId,
      // Deterministic so re-clicking the success page doesn't litter
      // `billing_events` with duplicate audit rows. The subscription/credits
      // upsert in `applyPlanUpgrade` still runs either way.
      stripeEventId: `stub_${req.user!.id}_${parsed.data.plan}`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
