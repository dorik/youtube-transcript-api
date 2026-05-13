'use client';

import dynamic from 'next/dynamic';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useUsageQuery, VideoCell, SourceCell, FormatCell } from '@/features/usage';

// Recharts is ~95 KB gz. Code-split so the rest of the dashboard doesn't
// pay for it. ssr:false because it depends on the DOM (ResponsiveContainer
// reads layout) and there's nothing meaningful to render on the server
// before the client takes over.
const UsageChart = dynamic(
  () => import('@/components/usage/UsageChart').then((m) => m.UsageChart),
  {
    ssr: false,
    loading: () => <Skeleton className="h-72" />,
  },
);

export default function UsagePage() {
  const usageQuery = useUsageQuery();
  const data = usageQuery.data;
  const loading = usageQuery.isLoading;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Usage</h1>
        <p className="text-muted-foreground text-sm">Last 30 days of activity.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Today" value={data?.totals.requests_today.toLocaleString() ?? '—'} loading={loading} />
        <StatCard label="This month" value={data?.totals.requests_this_month.toLocaleString() ?? '—'} loading={loading} />
        <StatCard label="Credits used" value={data?.totals.credits_used_this_month.toLocaleString() ?? '—'} loading={loading} />
        <StatCard label="Cache hits" value={data?.totals.cache_hits_this_month.toLocaleString() ?? '—'} loading={loading} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Requests per day</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-72" />
          ) : (
            <div className="h-72">
              <UsageChart daily={data?.daily ?? []} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent requests</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : !data?.recent.length ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4 font-medium">Time</th>
                    <th className="py-2 pr-4 font-medium">Endpoint</th>
                    <th className="py-2 pr-4 font-medium">Video</th>
                    <th className="py-2 pr-4 font-medium">Format</th>
                    <th className="py-2 pr-4 font-medium">Source</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium text-right">Latency</th>
                    <th className="py-2 pr-4 font-medium text-right">Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                        {new Date(r.created_at).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.endpoint}</td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        <VideoCell row={r} />
                      </td>
                      <td className="py-2 pr-4">
                        <FormatCell row={r} />
                      </td>
                      <td className="py-2 pr-4">
                        <SourceCell row={r} />
                      </td>
                      <td className="py-2 pr-4">{r.status_code}</td>
                      <td className="py-2 pr-4 text-right text-muted-foreground">
                        {r.response_time_ms ? `${r.response_time_ms}ms` : '—'}
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

function StatCard({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <p className="text-sm text-muted-foreground">{label}</p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div className="text-2xl font-bold tracking-tight">{value}</div>
        )}
      </CardContent>
    </Card>
  );
}
