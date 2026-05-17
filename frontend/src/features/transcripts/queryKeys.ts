import type { ListRequestsInput } from './types';

export const transcriptsQueryKeys = {
  all: ['transcripts'] as const,
  list: (input: ListRequestsInput) =>
    [...transcriptsQueryKeys.all, 'list', input] as const,
  detail: (id: string) => [...transcriptsQueryKeys.all, 'detail', id] as const,
  batch: (id: string) => [...transcriptsQueryKeys.all, 'batch', id] as const,
};
