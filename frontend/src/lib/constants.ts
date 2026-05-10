/**
 * App-wide named constants. Anything that's a magic number in component
 * code (timeouts, debounce delays, page sizes, retry counts) lives here.
 *
 * Feature-specific constants (per-component) can stay near their consumer
 * — the rule is "no unnamed numeric literals", not "everything goes here".
 */

/** Debounce for in-app search inputs (ms). */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * How long to keep a Blob URL alive after triggering a download (ms).
 * Browsers need a moment to actually fetch the blob before we can revoke.
 */
export const BLOB_URL_TTL_MS = 1000;

/** Default page size for paginated dashboard tables. */
export const DEFAULT_PAGE_SIZE = 25;
