import type { TranscriptResponse } from '@/lib/api';

/** Output formats the API supports. */
export const FORMATS = ['json', 'text', 'text-timestamps', 'srt', 'vtt'] as const;
export type Format = (typeof FORMATS)[number];

/**
 * One row in the playground's bulk-fetch result list. URLs are submitted
 * in a batch (one per line), so the results panel renders an array of
 * these. The `ok` discriminant splits the success and failure shapes:
 * success rows carry the rendered `data` plus the transcript-request
 * `requestId` (used to deep-link into the dashboard viewer route), and
 * failure rows carry an `error` string for the failure note.
 */
export type BulkResultEntry =
  | {
      url: string;
      ok: true;
      data: TranscriptResponse;
      requestId: string;
    }
  | {
      url: string;
      ok: false;
      error: string;
    };
