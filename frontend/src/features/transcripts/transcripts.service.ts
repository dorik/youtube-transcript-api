import { apiClient } from '@/lib/http/client';
import { createApi } from '@/lib/http/createApi';
import { methodsEnums } from '@/lib/http/constants';
import type {
  BatchCreateResponse,
  BatchDetailResponse,
  CreateBatchInput,
  CreateTranscriptInput,
  ListRequestsInput,
  RequestListResponse,
  TranscriptRequest,
} from './types';

function createTranscriptRequestQuery(input: CreateTranscriptInput) {
  return {
    url: '/me/transcripts',
    method: methodsEnums.POST,
    data: input,
  };
}

function createTranscriptBatchQuery(input: CreateBatchInput) {
  return {
    url: '/me/transcripts/bulk',
    method: methodsEnums.POST,
    data: input,
  };
}

function listTranscriptRequestsQuery(input: ListRequestsInput) {
  return {
    url: '/me/transcripts',
    method: methodsEnums.GET,
    params: { limit: input.limit, offset: input.offset },
  };
}

function getTranscriptRequestQuery(id: string) {
  return {
    url: `/me/transcripts/${id}`,
    method: methodsEnums.GET,
  };
}

function cancelTranscriptRequestQuery(id: string) {
  return {
    url: `/me/transcripts/${id}`,
    method: methodsEnums.DELETE,
  };
}

function getTranscriptBatchQuery(id: string) {
  return {
    url: `/me/transcripts/batches/${id}`,
    method: methodsEnums.GET,
  };
}

/** POST /me/transcripts — enqueue one request. */
export const createTranscriptRequest = createApi<
  CreateTranscriptInput,
  TranscriptRequest
>({
  queryFn: apiClient,
  request: createTranscriptRequestQuery,
});

/** POST /me/transcripts/bulk — enqueue a playlist/channel/url-list batch. */
export const createTranscriptBatch = createApi<
  CreateBatchInput,
  BatchCreateResponse
>({
  queryFn: apiClient,
  request: createTranscriptBatchQuery,
});

/** GET /me/transcripts — paginated list of the user's requests. */
export const listTranscriptRequests = createApi<
  ListRequestsInput,
  RequestListResponse
>({
  queryFn: apiClient,
  query: listTranscriptRequestsQuery,
});

/** GET /me/transcripts/:id — one request. */
export const getTranscriptRequest = createApi<string, TranscriptRequest>({
  queryFn: apiClient,
  query: getTranscriptRequestQuery,
});

/** DELETE /me/transcripts/:id — cancel a queued request. */
export const cancelTranscriptRequest = createApi<string, TranscriptRequest>({
  queryFn: apiClient,
  request: cancelTranscriptRequestQuery,
});

/** GET /me/transcripts/batches/:id — batch summary + entries. */
export const getTranscriptBatch = createApi<string, BatchDetailResponse>({
  queryFn: apiClient,
  query: getTranscriptBatchQuery,
});
