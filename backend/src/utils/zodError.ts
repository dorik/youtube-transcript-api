import { ZodError } from 'zod';

/**
 * Flatten a `ZodError` into the `details` payload for a `ValidationError`.
 *
 * `flatten()` splits issues two ways:
 *  - `fieldErrors` — issues with a path, keyed by field name.
 *  - `formErrors`  — issues with *no* path, produced by object-level
 *    `.superRefine`/`.refine` rules (e.g. the bulk route's "provide exactly
 *    one of: playlist, channel, urls").
 *
 * Routes previously sent only `fieldErrors` as `issues`, which left every
 * object-level validation failure answering with an empty `issues:{}` and
 * no explanation of what was wrong. Surface both: per-field issues under
 * `issues`, object-level messages under `errors` (omitted when there are
 * none, so per-field-only responses are unchanged).
 */
export function zodValidationDetails(error: ZodError): Record<string, unknown> {
  const flat = error.flatten();
  return {
    issues: flat.fieldErrors,
    ...(flat.formErrors.length > 0 ? { errors: flat.formErrors } : {}),
  };
}
