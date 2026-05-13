import { useMutation, useQuery } from '@tanstack/react-query';
import {
  fetchTranscriptAsUser,
  fetchTranscriptWithBearer,
  listTranscripts,
} from './transcripts.service';
import type {
  FetchTranscriptAsUserInput,
  FetchTranscriptWithBearerInput,
  HistoryResponse,
  ListTranscriptsInput,
  TranscriptResponse,
} from './types';
import { transcriptsQueryKeys } from './queryKeys';

export function useTranscriptsQuery(input: ListTranscriptsInput) {
  return useQuery<HistoryResponse, Error>({
    queryKey: transcriptsQueryKeys.list(input),
    queryFn: () => listTranscripts(input),
  });
}

export function useTranscriptQuery(input: FetchTranscriptAsUserInput, enabled: boolean) {
  return useQuery<TranscriptResponse, Error>({
    queryKey: transcriptsQueryKeys.detail(input),
    queryFn: () => fetchTranscriptAsUser(input),
    enabled,
    placeholderData: (previousData) => previousData,
    // A transcript for a given (videoId, language, translate_to) is
    // effectively immutable — once we have it, refetching just hits the
    // server cache and logs another `api_requests` row for no new info.
    // Two settings keep one user action = one HTTP request:
    //   - staleTime: Infinity  → never marked stale, so window-focus /
    //                            remount don't auto-refetch.
    //   - refetchOnWindowFocus: false → defense-in-depth for the same.
    // The query still refetches when the key changes (language /
    // translate_to switch), which is what the viewer's dropdowns rely on.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    meta: { suppressGlobalError: true },
  });
}

export function useFetchTranscriptAsUserMutation() {
  return useMutation<TranscriptResponse, Error, FetchTranscriptAsUserInput>({
    mutationFn: fetchTranscriptAsUser,
    meta: { suppressGlobalError: true },
  });
}

export function useFetchTranscriptWithBearerMutation() {
  return useMutation<TranscriptResponse, Error, FetchTranscriptWithBearerInput>({
    mutationFn: fetchTranscriptWithBearer,
    meta: { suppressGlobalError: true },
  });
}
