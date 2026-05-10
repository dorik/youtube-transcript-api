import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateStubPlan,
  getBillingOverview,
  getBillingSubscription,
  startCheckout,
} from './billing.service';
import type {
  BillingOverviewResponse,
  BillingSubscriptionResponse,
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
