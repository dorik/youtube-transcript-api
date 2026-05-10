export const apiKeysQueryKeys = {
  all: ['api-keys'] as const,
  list: () => [...apiKeysQueryKeys.all, 'list'] as const,
};
