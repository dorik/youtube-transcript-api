import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateStubPlan,
  changeSubscriptionPlan,
  getBillingOverview,
  getBillingSubscription,
  startCheckout,
} from './billing.service';
import type {
  BillingOverviewResponse,
  BillingSubscriptionResponse,
  ChangePlanResponse,
  CheckoutResponse,
  PaidPlanId,
  StubActivateResponse,
} from './types';
import { billingQueryKeys } from './queryKeys';

export function useBillingOverviewQuery() {
  return useQuery<BillingOverviewResponse, Error>({
    queryKey: billingQueryKeys.overview(),
    queryFn: getBillingOverview,
  });
}

export function useBillingSubscriptionQuery() {
  return useQuery<BillingSubscriptionResponse, Error>({
    queryKey: billingQueryKeys.subscription(),
    queryFn: () => getBillingSubscription(),
  });
}

export function useCheckoutMutation() {
  return useMutation<CheckoutResponse, Error, PaidPlanId>({
    mutationFn: startCheckout,
    meta: { suppressGlobalError: true },
  });
}

export function useStubActivateMutation() {
  const queryClient = useQueryClient();

  return useMutation<StubActivateResponse, Error, PaidPlanId>({
    mutationFn: activateStubPlan,
    meta: { suppressGlobalError: true },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingQueryKeys.all });
    },
  });
}

/**
 * Upgrade/downgrade an already-active subscription. The webhook handles the
 * DB sync, so we invalidate billing queries after a short delay to give it
 * time to land — otherwise an immediate refetch shows the old plan.
 */
const CHANGE_PLAN_REFETCH_DELAY_MS = 1500;

export function useChangePlanMutation() {
  const queryClient = useQueryClient();

  return useMutation<ChangePlanResponse, Error, PaidPlanId>({
    mutationFn: changeSubscriptionPlan,
    meta: { suppressGlobalError: true },
    onSuccess: () => {
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: billingQueryKeys.all });
      }, CHANGE_PLAN_REFETCH_DELAY_MS);
    },
  });
}
