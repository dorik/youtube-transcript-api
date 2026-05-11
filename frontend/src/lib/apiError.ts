import { ApiError } from "./api";

/**
 * Single source of truth for surfacing API errors as user-readable strings.
 *
 * Use this in every catch block / onError handler instead of inlining
 * `err instanceof ApiError ? err.message : "..."`. Keeps the extraction
 * logic in one place so we can extend it (e.g. localized messages, error
 * codes → friendly copy) without touching every call site.
 */
export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
