import type { FetchTranscriptAsUserInput, ListTranscriptsInput } from './types';

export const transcriptsQueryKeys = {
  all: ['transcripts'] as const,
  list: (input: ListTranscriptsInput) => [...transcriptsQueryKeys.all, 'list', input] as const,
  detail: (input: FetchTranscriptAsUserInput) =>
    [...transcriptsQueryKeys.all, 'detail', input] as const,
};
