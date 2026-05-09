'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { billing, usage as usageApi, UsageResponse, Subscription, CreditState } from '@/lib/api';

export default function OverviewPage() {
  const [data, setData] = useState<{
    sub: { subscription: Subscription | null; credits: CreditState };
    usage: UsageResponse;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([billing.subscription(), usageApi.get()])
      .then(([sub, usage]) => {
        if (alive) {
          setData({ sub, usage });
          setLoading(false);
        }
      })
      .catch(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground text-sm">Your account at a glance.</p>
        </div>
        <Button asChild>
          <Link href="/dashboard/api-keys">Create API key</Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Credits remaining"
          value={data?.sub.credits.balance.toLocaleString() ?? '—'}
          loading={loading}
          hint={
            data?.sub.credits.next_reset_at
              ? `Resets ${formatDate(data.sub.credits.next_reset_at)}`
              : undefined
          }
        />
        <StatCard
          label="Requests today"
          value={data?.usage.totals.requests_today.toLocaleString() ?? '—'}
          loading={loading}
        />
        <StatCard
          label="Cache hits this month"
          value={data?.usage.totals.cache_hits_this_month.toLocaleString() ?? '—'}
          loading={loading}
          hint={
            data && data.usage.totals.requests_this_month > 0
              ? `${Math.round((data.usage.totals.cache_hits_this_month / data.usage.totals.requests_this_month) * 100)}% hit rate`
              : undefined
          }
        />
        <StatCard
          label="Plan"
          value={data?.sub.subscription?.plan_name ?? 'Free'}
          loading={loading}
          hint={
            data?.sub.subscription
              ? `${data.sub.subscription.monthly_credits.toLocaleString()} credits / mo`
              : undefined
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : !data?.usage.recent.length ? (
            <p className="text-sm text-muted-foreground">
              No requests yet. Try the{' '}
              <Link href="/playground" className="font-medium text-foreground hover:underline">
                playground
              </Link>{' '}
              or hit the API with curl.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4 font-medium">Time</th>
                    <th className="py-2 pr-4 font-medium">Video</th>
                    <th className="py-2 pr-4 font-medium">Source</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium text-right">Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {data.usage.recent.slice(0, 8).map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                        {formatRelative(r.created_at)}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.video_id ?? '—'}</td>
                      <td className="py-2 pr-4">
                        {r.cache_hit
                          ? 'cached'
                          : r.transcript_source === 'whisper'
                            ? 'whisper'
                            : r.transcript_source ?? '—'}
                      </td>
                      <td className="py-2 pr-4">
                        <StatusBadge status={r.status_code} />
                      </td>
                      <td className="py-2 pr-4 text-right">{r.credits_used ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <p className="text-sm text-muted-foreground">{label}</p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <>
            <div className="text-3xl font-bold tracking-tight">{value}</div>
            {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: number }) {
  const ok = status >= 200 && status < 400;
  return (
    <span
      className={
        ok
          ? 'inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700'
          : 'inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700'
      }
    >
      {status}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}
