import type { TranscriptResponse } from '@/lib/api';

/** Output formats the API supports. */
export const FORMATS = ['json', 'text', 'text-timestamps', 'srt', 'vtt'] as const;
export type Format = (typeof FORMATS)[number];

/**
 * One row in the playground's bulk-fetch result list. URLs are submitted
 * in a batch (one per line), so the results panel renders an array of
 * these — `ok: false` rows carry an `error` string for the failure note.
 */
export interface BulkResultEntry {
  url: string;
  ok: boolean;
  data?: TranscriptResponse;
  error?: string;
}
