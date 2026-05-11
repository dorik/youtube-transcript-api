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
  mode: 'stub' | 'live';
}

export interface StubActivateResponse {
  ok: true;
}
