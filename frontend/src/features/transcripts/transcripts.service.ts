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

/** POST /me/transcripts — enqueue one request. */
export const createTranscriptRequest = createApi<
  CreateTranscriptInput,
  TranscriptRequest
>({
  queryFn: apiClient,
  request: (input) => ({
    url: '/me/transcripts',
    method: methodsEnums.POST,
    data: input,
  }),
});

/** POST /me/transcripts/bulk — enqueue a playlist/channel/url-list batch. */
export const createTranscriptBatch = createApi<
  CreateBatchInput,
  BatchCreateResponse
>({
  queryFn: apiClient,
  request: (input) => ({
    url: '/me/transcripts/bulk',
    method: methodsEnums.POST,
    data: input,
  }),
});

/** GET /me/transcripts — paginated list of the user's requests. */
export const listTranscriptRequests = createApi<
  ListRequestsInput,
  RequestListResponse
>({
  queryFn: apiClient,
  query: (input) => ({
    url: '/me/transcripts',
    method: methodsEnums.GET,
    params: { limit: input.limit, offset: input.offset },
  }),
});

/** GET /me/transcripts/:id — one request. */
export const getTranscriptRequest = createApi<string, TranscriptRequest>({
  queryFn: apiClient,
  query: (id) => ({
    url: `/me/transcripts/${id}`,
    method: methodsEnums.GET,
  }),
});

/** DELETE /me/transcripts/:id — cancel a queued request. */
export const cancelTranscriptRequest = createApi<string, TranscriptRequest>({
  queryFn: apiClient,
  request: (id) => ({
    url: `/me/transcripts/${id}`,
    method: methodsEnums.DELETE,
  }),
});

/** GET /me/transcripts/batches/:id — batch summary + entries. */
export const getTranscriptBatch = createApi<string, BatchDetailResponse>({
  queryFn: apiClient,
  query: (id) => ({
    url: `/me/transcripts/batches/${id}`,
    method: methodsEnums.GET,
  }),
});
