import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelTranscriptRequest,
  createTranscriptBatch,
  createTranscriptRequest,
  getTranscriptBatch,
  getTranscriptRequest,
  listTranscriptRequests,
} from './transcripts.service';
import { transcriptsQueryKeys } from './queryKeys';
import type {
  BatchCreateResponse,
  BatchDetailResponse,
  CreateBatchInput,
  CreateTranscriptInput,
  ListRequestsInput,
  RequestListResponse,
  TranscriptRequest,
} from './types';

/** A request is still moving while queued or processing. */
function isActive(status: TranscriptRequest['status']): boolean {
  return status === 'queued' || status === 'processing';
}

export function useTranscriptRequestsQuery(input: ListRequestsInput) {
  return useQuery<RequestListResponse, Error>({
    queryKey: transcriptsQueryKeys.list(input),
    queryFn: () => listTranscriptRequests(input),
    // Poll while any row is still queued/processing so the list advances
    // through queued → processing → done without a manual refresh.
    refetchInterval: (query) =>
      query.state.data?.items.some((r) => isActive(r.status)) ? 4000 : false,
  });
}

export function useTranscriptRequestQuery(id: string, enabled: boolean) {
  return useQuery<TranscriptRequest, Error>({
    queryKey: transcriptsQueryKeys.detail(id),
    queryFn: () => getTranscriptRequest(id),
    enabled,
    refetchInterval: (query) =>
      query.state.data && isActive(query.state.data.status) ? 5000 : false,
    meta: { suppressGlobalError: true },
  });
}

export function useTranscriptBatchQuery(id: string, enabled: boolean) {
  return useQuery<BatchDetailResponse, Error>({
    queryKey: transcriptsQueryKeys.batch(id),
    queryFn: () => getTranscriptBatch(id),
    enabled,
    refetchInterval: (query) => {
      const p = query.state.data?.progress;
      return p && p.queued + p.processing > 0 ? 6000 : false;
    },
  });
}

export function useCreateTranscriptMutation() {
  const qc = useQueryClient();
  return useMutation<TranscriptRequest, Error, CreateTranscriptInput>({
    mutationFn: createTranscriptRequest,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: transcriptsQueryKeys.all });
    },
    meta: { suppressGlobalError: true },
  });
}

export function useCreateBatchMutation() {
  const qc = useQueryClient();
  return useMutation<BatchCreateResponse, Error, CreateBatchInput>({
    mutationFn: createTranscriptBatch,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: transcriptsQueryKeys.all });
    },
    meta: { suppressGlobalError: true },
  });
}

export function useCancelTranscriptMutation() {
  const qc = useQueryClient();
  return useMutation<TranscriptRequest, Error, string>({
    mutationFn: cancelTranscriptRequest,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: transcriptsQueryKeys.all });
    },
    meta: { suppressGlobalError: true },
  });
}
