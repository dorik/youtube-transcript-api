export const usageQueryKeys = {
  all: ['usage'] as const,
  detail: () => [...usageQueryKeys.all, 'detail'] as const,
};
