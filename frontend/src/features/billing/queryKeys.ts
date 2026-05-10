export const billingQueryKeys = {
  all: ['billing'] as const,
  overview: () => [...billingQueryKeys.all, 'overview'] as const,
  subscription: () => [...billingQueryKeys.all, 'subscription'] as const,
};
