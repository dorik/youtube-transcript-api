import { apiClient } from '@/lib/http/client';
import { createApi } from '@/lib/http/createApi';
import { methodsEnums } from '@/lib/http/constants';
import type { UsageResponse } from './types';

function getUsageQuery() {
  return {
    url: '/me/usage',
    method: methodsEnums.GET,
  };
}

export const getUsage = createApi<void, UsageResponse>({
  queryFn: apiClient,
  query: getUsageQuery,
});
