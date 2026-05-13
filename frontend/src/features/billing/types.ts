import type { CreditState, Plan, Subscription } from '@/lib/api';

export type PaidPlanId = 'starter' | 'pro' | 'business';

export interface BillingPlansResponse {
  plans: Plan[];
}

export interface BillingSubscriptionResponse {
  subscription: Subscription | null;
  credits: CreditState;
}

export interface BillingOverviewResponse {
  plans: Plan[];
  subscription: Subscription | null;
  credits: CreditState;
}

export interface CheckoutResponse {
  url: string;
}

/**
 * `/billing/change-plan` response. Used for upgrades/downgrades of an
 * already-active subscription — does NOT mint a new Stripe session, so
 * there's no `url` to redirect to.
 *
 * - `changed`: Stripe accepted the price swap; the webhook will refresh our
 *   DB shortly.
 * - `noop`: User is already on this plan, server skipped the call.
 */
export interface ChangePlanResponse {
  status: 'changed' | 'noop';
}
