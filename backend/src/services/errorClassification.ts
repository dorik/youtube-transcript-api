import {
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
