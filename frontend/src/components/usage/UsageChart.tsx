'use client';

import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import type { UsageResponse } from '@/lib/api';

/**
 * Recharts is ~95 KB gz. Splitting it out so it only ships with the
 * `/dashboard/usage` route and not every other dashboard page that imports
 * the layout. Dynamic-imported from the page (see usage/page.tsx).
 */
export function UsageChart({ daily }: { daily: UsageResponse['daily'] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={daily}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--muted))" />
        <XAxis
          dataKey="day"
          fontSize={11}
          stroke="hsl(var(--muted-foreground))"
          tickFormatter={(v: string) => v.slice(5)}
        />
        <YAxis fontSize={11} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
        <Tooltip />
        <Line
          type="monotone"
          dataKey="requests"
          stroke="hsl(var(--foreground))"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
