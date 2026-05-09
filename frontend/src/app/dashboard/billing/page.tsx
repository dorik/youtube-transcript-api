'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  ApiError,
  billing,
  CreditState,
  Plan,
  Subscription,
} from '@/lib/api';

export default function BillingPage() {
  const params = useSearchParams();
  const router = useRouter();

  const [data, setData] = useState<{
    plans: Plan[];
    sub: Subscription | null;
    credits: CreditState;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);

  // Stub-mode redirect handling: if we arrive with ?stub_success=1&plan=…
  // call the stub-activate endpoint and refresh.
  useEffect(() => {
    const stubSuccess = params.get('stub_success');
    const planParam = params.get('plan');
    if (stubSuccess && (planParam === 'starter' || planParam === 'pro' || planParam === 'business')) {
      billing
        .stubActivate(planParam)
        .then(() => {
          toast.success(`Upgraded to ${planParam} (stub)`);
          // Strip the URL params so a refresh doesn't re-activate
          router.replace('/dashboard/billing');
          load();
        })
        .catch((err: unknown) => {
          toast.error(err instanceof ApiError ? err.message : 'Stub activation failed');
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [plansResp, subResp] = await Promise.all([billing.plans(), billing.subscription()]);
      setData({
        plans: plansResp.plans,
        sub: subResp.subscription,
        credits: subResp.credits,
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load billing');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onUpgrade(planId: 'starter' | 'pro' | 'business') {
    setBusyPlan(planId);
    try {
      const { url, mode } = await billing.checkout(planId);
      if (mode === 'live') {
        window.location.href = url; // Stripe redirect
      } else {
        // Stub mode: the URL is /dashboard/billing?stub_success=1&plan=…,
        // which will trigger the activation effect when we land there.
        window.location.href = url;
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start checkout');
      setBusyPlan(null);
    }
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
                <p className="text-2xl font-bold">{data?.sub?.plan_name ?? 'Free'}</p>
                <p className="text-xs text-muted-foreground capitalize">
                  {data?.sub?.status ?? 'active'}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Credits</p>
                <p className="text-2xl font-bold">
                  {data?.credits.balance.toLocaleString()}{' '}
                  <span className="text-sm font-normal text-muted-foreground">
                    / {data?.sub?.monthly_credits.toLocaleString() ?? 100}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Renews</p>
                <p className="text-2xl font-bold">
                  {data?.sub?.billing_cycle_end
                    ? new Date(data.sub.billing_cycle_end).toLocaleDateString()
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
          const isCurrent = data?.sub?.plan_id === plan.id;
          const highlighted = plan.id === 'pro';
          return (
            <Card
              key={plan.id}
              className={cn(
                'relative flex flex-col',
                highlighted && 'border-foreground',
                isCurrent && 'ring-2 ring-foreground/20',
              )}
            >
              {highlighted && !isCurrent && (
                <Badge className="absolute -top-3 left-1/2 -translate-x-1/2">Most popular</Badge>
              )}
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
                    variant={highlighted ? 'default' : 'outline'}
                    onClick={() => onUpgrade(plan.id as 'starter' | 'pro' | 'business')}
                    disabled={busyPlan !== null}
                  >
                    {busyPlan === plan.id ? 'Redirecting…' : `Upgrade to ${plan.name}`}
                  </Button>
                )}
              </CardContent>
            </Card>
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
