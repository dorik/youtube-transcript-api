import type {
  BatchCreateResponse,
  BatchDetailResponse,
  RequestListResponse,
  TranscriptRequest,
  TranscriptResponse,
} from '@/lib/api';

export interface CreateTranscriptInput {
  url: string;
  format?: string;
  language?: string;
  native_only?: boolean;
  translate_to?: string;
}

export interface CreateBatchInput {
  /** Exactly one of playlist / channel / urls. */
  playlist?: string;
  channel?: string;
  urls?: string[];
  format?: string;
  language?: string;
  native_only?: boolean;
  translate_to?: string;
  limit?: number;
}

export interface ListRequestsInput {
  limit?: number;
  offset?: number;
}

export type {
  BatchCreateResponse,
  BatchDetailResponse,
  RequestListResponse,
  TranscriptRequest,
  TranscriptResponse,
};
