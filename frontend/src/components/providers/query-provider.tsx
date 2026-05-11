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
import { getApiErrorMessage } from '@/lib/apiError';

const DEFAULT_STALE_TIME_MS = 30_000;
const SUPPRESS_GLOBAL_ERROR_META = 'suppressGlobalError';

function shouldSuppressGlobalError(meta: Record<string, unknown> | undefined) {
  return meta?.[SUPPRESS_GLOBAL_ERROR_META] === true;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: DEFAULT_STALE_TIME_MS,
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
