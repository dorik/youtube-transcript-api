import { useQuery } from '@tanstack/react-query';
import { getUsage } from './usage.service';
import type { UsageResponse } from './types';
import { usageQueryKeys } from './queryKeys';

export function useUsageQuery() {
  return useQuery<UsageResponse, Error>({
    queryKey: usageQueryKeys.detail(),
    queryFn: () => getUsage(),
  });
}
