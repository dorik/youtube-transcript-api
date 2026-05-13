import { apiClient } from '@/lib/http/client';
import { createApi } from '@/lib/http/createApi';
import { methodsEnums } from '@/lib/http/constants';
import type {
  BillingOverviewResponse,
  BillingPlansResponse,
  BillingSubscriptionResponse,
  ChangePlanResponse,
  CheckoutResponse,
  PaidPlanId,
} from './types';

function getPlansQuery() {
  return {
    url: '/billing/plans',
    method: methodsEnums.GET,
  };
}

function getBillingSubscriptionQuery() {
  return {
    url: '/billing/subscription',
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

function changeSubscriptionPlanQuery(plan: PaidPlanId) {
  return {
    url: '/billing/change-plan',
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

export const changeSubscriptionPlan = createApi<PaidPlanId, ChangePlanResponse>({
  queryFn: apiClient,
  query: changeSubscriptionPlanQuery,
});
