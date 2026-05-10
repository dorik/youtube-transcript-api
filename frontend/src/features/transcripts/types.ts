import type {
  FetchTranscriptInput,
  HistoryResponse,
  TranscriptResponse,
} from '@/lib/api';

export interface ListTranscriptsInput {
  limit?: number;
  offset?: number;
  q?: string;
}

export type FetchTranscriptAsUserInput = FetchTranscriptInput;

export interface FetchTranscriptWithBearerInput extends FetchTranscriptInput {
  bearer: string;
}

export type { FetchTranscriptInput, HistoryResponse, TranscriptResponse };
