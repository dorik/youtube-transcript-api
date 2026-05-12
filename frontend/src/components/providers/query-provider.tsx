'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/apiError';

const DEFAULT_STALE_TIME_MS = 30_000;
const SUPPRESS_GLOBAL_ERROR_META = 'suppressGlobalError';
const MAX_QUERY_RETRIES = 2;

function shouldSuppressGlobalError(meta: Record<string, unknown> | undefined) {
  return meta?.[SUPPRESS_GLOBAL_ERROR_META] === true;
}

/**
 * Global retry policy. React Query's default is 3 retries on every failure,
 * which is wrong for our shape of errors:
 *
 *   - 4xx — the answer won't change in 3s (invalid URL, no transcript,
 *     payment required, unauthorized). Retrying just delays the message
 *     the user actually needs to see.
 *   - 503 `upstream_blocked` — YouTube is challenging our IP. The block
 *     is per-egress, not per-request; retrying immediately wastes proxy
 *     bandwidth and burns through Whisper credits without unblocking.
 *   - 5xx (non-503) and network errors — these can be transient. A
 *     couple of retries with React Query's exponential backoff is fine.
 *
 * Per-query overrides still win; pass `retry: false` (or a number) on a
 * specific `useQuery` if it needs different behavior.
 */
function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  if (error instanceof ApiError) {
    if (error.status >= 400 && error.status < 500) return false;
    if (error.status === 503) return false;
  }
  return true;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: DEFAULT_STALE_TIME_MS,
            retry: shouldRetryQuery,
          },
          mutations: {
            retry: false,
          },
        },
        queryCache: new QueryCache({
          onError: (error, query) => {
            if (shouldSuppressGlobalError(query.meta)) return;
            toast.error(getApiErrorMessage(error, 'Could not load data'));
          },
        }),
        mutationCache: new MutationCache({
          onError: (error, _variables, _context, mutation) => {
            if (shouldSuppressGlobalError(mutation.meta)) return;
            toast.error(getApiErrorMessage(error, 'Request failed'));
          },
        }),
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
