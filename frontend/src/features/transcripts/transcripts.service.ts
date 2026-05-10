import { apiClient } from '@/lib/http/client';
import { createApi } from '@/lib/http/createApi';
import { methodsEnums } from '@/lib/http/constants';
import type {
  FetchTranscriptAsUserInput,
  FetchTranscriptInput,
  FetchTranscriptWithBearerInput,
  HistoryResponse,
  ListTranscriptsInput,
  TranscriptResponse,
} from './types';

function transcriptQuery(input: FetchTranscriptInput) {
  const translate =
    input.translate_to && input.translate_to !== 'none' ? input.translate_to : undefined;

  return {
    url: input.url,
    format: input.format,
    language: input.language,
    native_only: input.native_only ? 'true' : undefined,
    translate_to: translate,
  };
}

function listTranscriptsQuery(input: ListTranscriptsInput) {
  return {
    url: '/me/transcripts',
    method: methodsEnums.GET,
    params: input,
  };
}

function fetchTranscriptAsUserQuery(input: FetchTranscriptAsUserInput) {
  return {
    url: '/me/transcript',
    method: methodsEnums.GET,
    params: transcriptQuery(input),
  };
}

function fetchTranscriptWithBearerQuery({
  bearer,
  ...input
}: FetchTranscriptWithBearerInput) {
  return {
    url: '/v1/transcript',
    method: methodsEnums.GET,
    params: transcriptQuery(input),
    config: {
      headers: {
        Authorization: `Bearer ${bearer}`,
      },
    },
  };
}

export const listTranscripts = createApi<ListTranscriptsInput, HistoryResponse>({
  queryFn: apiClient,
  query: listTranscriptsQuery,
});

export const fetchTranscriptAsUser = createApi<FetchTranscriptAsUserInput, TranscriptResponse>({
  queryFn: apiClient,
  query: fetchTranscriptAsUserQuery,
});

export const fetchTranscriptWithBearer = createApi<
  FetchTranscriptWithBearerInput,
  TranscriptResponse
>({
  queryFn: apiClient,
  query: fetchTranscriptWithBearerQuery,
});
