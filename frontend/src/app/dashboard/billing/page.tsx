'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/apiError';
import {
  useBillingOverviewQuery,
  useCheckoutMutation,
  useStubActivateMutation,
  type PaidPlanId,
} from '@/features/billing';

// Plan tiers ordered low → high. Used to label the action button on each
// plan card: a card whose rank is below the user's current plan is a
// "Downgrade", above is an "Upgrade".
const PLAN_RANK: Record<string, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  business: 3,
};

export default function BillingPage() {
  const [busyPlan, setBusyPlan] = useState<string | null>(null);

  const billingOverviewQuery = useBillingOverviewQuery();
  const checkoutMutation = useCheckoutMutation();
  const stubActivateMutation = useStubActivateMutation();

  const data = billingOverviewQuery.data;
  const loading = billingOverviewQuery.isLoading;
  const currentPlanId = data?.subscription?.plan_id ?? 'free';
  const currentRank = PLAN_RANK[currentPlanId] ?? 0;

  function onPlanChange(planId: PaidPlanId) {
    setBusyPlan(planId);
    checkoutMutation.mutate(planId, {
      onSuccess: ({ url, mode }) => {
        if (mode === 'stub') {
          // No real Stripe in stub mode — apply the change locally instead
          // of round-tripping through `?stub_success=1`. The previous flow
          // (full-document redirect + URL-driven useEffect) was prone to a
          // mutation re-fire loop; calling stub-activate straight from the
          // checkout response keeps it linear.
          stubActivateMutation.mutate(planId, {
            onSuccess: () => {
              toast.success(`Switched to ${planId} (stub)`);
              setBusyPlan(null);
            },
            onError: (err) => {
              toast.error(getApiErrorMessage(err, 'Stub activation failed'));
              setBusyPlan(null);
            },
          });
          return;
        }
        // Live Stripe — full-document redirect (cross-origin, no SPA nav).
        window.location.href = url;
      },
      onError: (err) => {
        toast.error(getApiErrorMessage(err, 'Could not start checkout'));
        setBusyPlan(null);
      },
    });
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="text-muted-foreground text-sm">Manage your subscription and view your plan.</p>
      </div>

      {/* Current plan summary */}
      <Card>
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-20" />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div>
                <p className="text-sm text-muted-foreground">Plan</p>
                <p className="text-2xl font-bold">{data?.subscription?.plan_name ?? 'Free'}</p>
                <p className="text-xs text-muted-foreground capitalize">
                  {data?.subscription?.status ?? 'active'}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Credits</p>
                <p className="text-2xl font-bold">
                  {data?.credits.balance.toLocaleString()}{' '}
                  <span className="text-sm font-normal text-muted-foreground">
                    / {data?.subscription?.monthly_credits.toLocaleString() ?? 100}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Renews</p>
                <p className="text-2xl font-bold">
                  {data?.subscription?.billing_cycle_end
                    ? new Date(data.subscription.billing_cycle_end).toLocaleDateString()
                    : '—'}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Plans */}
      <h2 className="text-xl font-semibold mt-4">Change plan</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {(data?.plans ?? []).map((plan) => {
          const isCurrent = currentPlanId === plan.id;
          const highlighted = plan.id === 'pro';
          const planRank = PLAN_RANK[plan.id] ?? 0;
          const isDowngrade = !isCurrent && plan.id !== 'free' && planRank < currentRank;
          const actionLabel = isDowngrade ? 'Downgrade' : 'Upgrade';
          const busyLabel = isDowngrade ? 'Switching…' : 'Redirecting…';
          return (
            // Wrapper provides the positioning context for the badge. The
            // Card primitive sets `overflow-hidden` on its root, so anchoring
            // the badge to the Card would clip it. Anchoring to this wrapper
            // lets the badge sit *above* the card edge unclipped.
            <div key={plan.id} className="relative">
              {highlighted && !isCurrent && (
                <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 z-10">
                  Most popular
                </Badge>
              )}
              <Card
                className={cn(
                  'flex flex-col h-full',
                  highlighted && 'border-foreground',
                  isCurrent && 'ring-2 ring-foreground/20',
                )}
              >
                <CardHeader>
                <CardTitle className="text-lg">{plan.name}</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col">
                <div className="mb-3">
                  <span className="text-3xl font-bold">${plan.price_usd}</span>
                  <span className="text-muted-foreground"> / mo</span>
                </div>
                <p className="text-sm text-muted-foreground mb-4">
                  {plan.monthly_credits.toLocaleString()} credits / month
                </p>
                {isCurrent ? (
                  <Button disabled variant="outline" className="mt-auto">
                    Current plan
                  </Button>
                ) : plan.id === 'free' ? (
                  <Button disabled variant="outline" className="mt-auto">
                    Free tier
                  </Button>
                ) : (
                  <Button
                    className="mt-auto"
                    variant={highlighted && !isDowngrade ? 'default' : 'outline'}
                    onClick={() => onPlanChange(plan.id as PaidPlanId)}
                    disabled={busyPlan !== null}
                  >
                    {busyPlan === plan.id ? busyLabel : `${actionLabel} to ${plan.name}`}
                  </Button>
                )}
              </CardContent>
              </Card>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Stub billing mode is active. Upgrades are simulated locally; no real charges happen.
        Set <code className="font-mono">STUB_STRIPE=false</code> on the backend to use live Stripe.
      </p>
    </div>
  );
}
