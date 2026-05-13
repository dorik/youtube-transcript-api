'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useBillingSubscriptionQuery } from '@/features/billing';
import { useUsageQuery } from '@/features/usage';
import { formatDate, formatRelativeTime } from '@/lib/format';
import type { UsageRecentEntry } from '@/lib/api';

export default function OverviewPage() {
  const billingQuery = useBillingSubscriptionQuery();
  const usageQuery = useUsageQuery();
  const loading = billingQuery.isLoading || usageQuery.isLoading;
  const billingData = billingQuery.data;
  const usageData = usageQuery.data;

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
          value={billingData?.credits.balance.toLocaleString() ?? '—'}
          loading={loading}
          hint={
            billingData?.credits.next_reset_at
              ? `Resets ${formatDate(billingData.credits.next_reset_at)}`
              : undefined
          }
        />
        <StatCard
          label="Requests today"
          value={usageData?.totals.requests_today.toLocaleString() ?? '—'}
          loading={loading}
        />
        <StatCard
          label="Cache hits this month"
          value={usageData?.totals.cache_hits_this_month.toLocaleString() ?? '—'}
          loading={loading}
          hint={
            usageData && usageData.totals.requests_this_month > 0
              ? `${Math.round((usageData.totals.cache_hits_this_month / usageData.totals.requests_this_month) * 100)}% hit rate`
              : undefined
          }
        />
        <StatCard
          label="Plan"
          value={billingData?.subscription?.plan_name ?? 'Free'}
          loading={loading}
          hint={
            billingData?.subscription
              ? `${billingData.subscription.monthly_credits.toLocaleString()} credits / mo`
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
          ) : !usageData?.recent.length ? (
            <p className="text-sm text-muted-foreground">
              No requests yet. Try the{' '}
              <Link href="/dashboard/playground" className="font-medium text-foreground hover:underline">
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
                  {usageData.recent.slice(0, 8).map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                        {formatRelativeTime(r.created_at)}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.video_id ?? '—'}</td>
                      <td className="py-2 pr-4">
                        <SourceCell row={r} />
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

/**
 * Show what produced the transcript. We no longer surface cache-hit as a
 * separate chip — the Credits column already tells that story (0 for a
 * cache hit, 1 for fresh work). Failed requests have no source, so the
 * error code goes here instead.
 */
function SourceCell({ row }: { row: UsageRecentEntry }) {
  if (row.status_code >= 400) {
    return (
      <span className="font-mono text-xs text-red-700">
        {row.error_code ?? 'error'}
      </span>
    );
  }

  // We label the Whisper path as "OpenAI" in the UI because that's the
  // service name the user recognizes — Whisper is the model, OpenAI is the
  // vendor. Stored value in `api_requests.transcript_source` stays
  // `'whisper'` so dashboards / queries keep working.
  const sourceLabel =
    row.transcript_source === 'whisper'
      ? 'OpenAI'
      : row.transcript_source === 'native_captions'
        ? 'native'
        : null;

  return <span>{sourceLabel ?? '—'}</span>;
}

