import { apiClient } from '@/lib/http/client';
import { createApi } from '@/lib/http/createApi';
import { methodsEnums } from '@/lib/http/constants';
import type {
  BillingOverviewResponse,
  BillingPlansResponse,
  BillingSubscriptionResponse,
  CheckoutResponse,
  PaidPlanId,
  StubActivateResponse,
} from './types';

function getPlansQuery() {
  return {
    url: '/plans',
    method: methodsEnums.GET,
  };
}

function getBillingSubscriptionQuery() {
  return {
    url: '/me/subscription',
    method: methodsEnums.GET,
  };
}

function startCheckoutQuery(plan: PaidPlanId) {
  return {
    url: '/billing/checkout',
    method: methodsEnums.POST,
    data: { plan },
  };
}

function activateStubPlanQuery(plan: PaidPlanId) {
  return {
    url: '/billing/stub-activate',
    method: methodsEnums.POST,
    data: { plan },
  };
}

export const getBillingPlans = createApi<void, BillingPlansResponse>({
  queryFn: apiClient,
  query: getPlansQuery,
});

export const getBillingSubscription = createApi<void, BillingSubscriptionResponse>({
  queryFn: apiClient,
  query: getBillingSubscriptionQuery,
});

export async function getBillingOverview(): Promise<BillingOverviewResponse> {
  const [plansResp, subResp] = await Promise.all([
    getBillingPlans(),
    getBillingSubscription(),
  ]);

  return {
    plans: plansResp.plans,
    subscription: subResp.subscription,
    credits: subResp.credits,
  };
}

export const startCheckout = createApi<PaidPlanId, CheckoutResponse>({
  queryFn: apiClient,
  query: startCheckoutQuery,
});

export const activateStubPlan = createApi<PaidPlanId, StubActivateResponse>({
  queryFn: apiClient,
  query: activateStubPlanQuery,
});
