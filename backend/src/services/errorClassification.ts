import { UnrecoverableError } from 'bullmq';
import {
  ApiError,
  NoTranscriptError,
  UpgradeRequiredError,
  ValidationError,
  PaymentRequiredError,
  VideoNotFoundError,
  UpstreamBlockedError,
} from '../utils/errors';

export type ErrorKind = 'transient' | 'permanent';

/**
 * Decide whether a worker failure should be retried.
 *
 * - permanent: re-running will fail the same way (no captions, bad input, the
 *   user can't pay). The worker fails the job immediately, no retry.
 * - transient: a retry has a real chance of succeeding (YouTube blocked our
 *   IP, a network blip). BullMQ retries with backoff.
 *
 * Default is transient — an unrecognized error is more likely a blip than a
 * deterministic dead end, and BullMQ caps retries at 3 anyway.
 */
export function classifyError(err: unknown): ErrorKind {
  if (
    err instanceof NoTranscriptError ||
    err instanceof UpgradeRequiredError ||
    err instanceof ValidationError ||
    err instanceof PaymentRequiredError ||
    err instanceof VideoNotFoundError
  ) {
    return 'permanent';
  }
  if (err instanceof UpstreamBlockedError) {
    return 'transient';
  }
  return 'transient';
}

export interface FailureCode {
  code: string;
  status: number;
}

/**
 * Derive the `{ code, status }` a failed transcript job should be recorded
 * under, from whatever error the worker caught.
 *
 * The worker re-throws permanent failures as a BullMQ `UnrecoverableError`
 * to stop retries — but that wrapper would otherwise erase the original
 * `ApiError.code`, leaving every permanent failure recorded as a generic
 * `PERMANENT_FAILURE`. `processTranscribe` copies `code`/`status` onto the
 * wrapper before throwing; this reads them back so a missing video surfaces
 * as `VIDEO_NOT_FOUND` (404), a captionless one as `NO_TRANSCRIPT`, etc.
 */
export function resolveFailureCode(err: unknown): FailureCode {
  if (err instanceof ApiError) {
    return { code: err.code, status: err.status };
  }
  if (err !== null && typeof err === 'object') {
    const carrier = err as { code?: unknown; status?: unknown };
    if (typeof carrier.code === 'string') {
      return {
        code: carrier.code,
        status: typeof carrier.status === 'number' ? carrier.status : 500,
      };
    }
  }
  if (err instanceof UnrecoverableError) {
    return { code: 'PERMANENT_FAILURE', status: 500 };
  }
  return { code: 'INTERNAL_ERROR', status: 500 };
}
