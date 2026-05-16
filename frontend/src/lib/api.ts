/**
 * Typed client for the backend API.
 *
 * - Uses fetch with `credentials: 'include'` so the JWT cookie travels.
 * - Parses our error envelope `{ error, code, message, ... }` into ApiError.
 * - Single source of truth for endpoint shapes — keep this in sync with the
 *   backend's route definitions.
 */

/**
 * Public-facing API origin. Exported so playground/docs code-snippet
 * builders can render correct curl/JS/Python examples without reading
 * `process.env.NEXT_PUBLIC_API_URL` directly (CLAUDE.md §4.1 forbids that).
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const BASE_URL = API_BASE_URL;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /**
   * If true, return the raw Response so the caller can read text/blob (used
   * for SRT/VTT downloads). Default false → caller gets parsed JSON.
   */
  raw?: boolean;
  /**
   * Bearer token to send instead of the cookie (used by the playground when
   * an API key is supplied directly).
   */
  bearer?: string;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, raw = false, bearer } = opts;
  const url = new URL(path, BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

  const res = await fetch(url.toString(), {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  if (raw) return res as unknown as T;

  const contentType = res.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const env = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    throw new ApiError(
      res.status,
      typeof env.code === 'string' ? env.code : 'UNKNOWN',
      typeof env.message === 'string' ? env.message : `Request failed (${res.status})`,
      env,
    );
  }

  return data as T;
}

/* -------------------- Domain types -------------------- */

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  created_at?: string;
  last_login_at?: string | null;
}

export interface ApiKey {
  id: string;
  prefix: string | null;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  is_revoked: boolean;
}

export interface Plan {
  id: 'free' | 'starter' | 'pro' | 'business';
  name: string;
  price_usd: number;
  monthly_credits: number;
}

export interface Subscription {
  plan_id: Plan['id'];
  plan_name: string;
  monthly_credits: number;
  status: string;
  billing_cycle_start: string;
  billing_cycle_end: string;
  cancelled_at: string | null;
}

export interface CreditState {
  balance: number;
  total_allocated: number;
  total_used: number;
  last_reset_at: string | null;
  next_reset_at: string | null;
}

export interface UsageTotals {
  requests_today: number;
  requests_this_month: number;
  credits_used_today: number;
  credits_used_this_month: number;
  cache_hits_this_month: number;
}

export interface UsageDailyEntry {
  day: string;
  requests: number;
  credits: number;
}

export interface UsageRecentEntry {
  id: string;
  created_at: string;
  method: string;
  endpoint: string;
  status_code: number;
  video_id: string | null;
  format: string | null;
  transcript_source: string | null;
  cache_hit: boolean | null;
  credits_used: number | null;
  response_time_ms: number | null;
  error_code: string | null;
}

export interface UsageResponse {
  totals: UsageTotals;
  by_source: Array<{ source: string | null; count: number }>;
  daily: UsageDailyEntry[];
  recent: UsageRecentEntry[];
}

export interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

export interface TranscriptResponse {
  video_id: string;
  url: string;
  title: string;
  channel: string;
  duration: number;
  /** Language of the text the user is currently looking at. */
  language: string;
  /** Original language YouTube/Whisper produced (always set). */
  original_language: string;
  /** Set when a translation was applied; null otherwise. */
  translated_to: string | null;
  source: 'native_captions' | 'whisper';
  format: string;
  transcript: string;
  segments?: TranscriptSegment[];
  /**
   * Untranslated content (only present when a translation was applied).
   * Lets the viewer offer an instant Original ⇄ Translated toggle without
   * a second API round-trip.
   */
  original_transcript?: string;
  original_segments?: TranscriptSegment[];
  credits_used: number;
  credits_remaining: number;
  cached: boolean;
  fetched_at: string;
}

export type RequestStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface TranscriptRequestConfig {
  url: string;
  format: string;
  language?: string;
  native_only?: boolean;
  translate_to?: string;
}

/** A transcript_requests row — the unit of the async queue. */
export interface TranscriptRequest {
  id: string;
  source: 'api' | 'dashboard';
  status: RequestStatus;
  request: TranscriptRequestConfig;
  video_id: string | null;
  title: string | null;
  channel: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  attempts: number;
  result: TranscriptResponse | null;
  credits_used: number | null;
  error_code: string | null;
  error_message: string | null;
  batch_id: string | null;
  batch_position: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface TranscriptBatch {
  id: string;
  kind: 'playlist' | 'channel' | 'videos';
  source_url: string | null;
  label: string | null;
  total: number;
  created_at: string;
}

export interface BatchProgress {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  canceled: number;
}

export interface RequestListResponse {
  items: TranscriptRequest[];
  total: number;
  limit: number;
  offset: number;
}

export interface BatchDetailResponse {
  batch: TranscriptBatch;
  progress: BatchProgress;
  requests: TranscriptRequest[];
}

export interface BatchCreateResponse {
  batch: TranscriptBatch;
  requests: TranscriptRequest[];
}

/* -------------------- API surface -------------------- */

export const auth = {
  signup: (input: { email: string; password: string; display_name?: string }) =>
    api<{ user: User }>('/auth/signup', { method: 'POST', body: input }),
  login: (input: { email: string; password: string }) =>
    api<{ user: User }>('/auth/login', { method: 'POST', body: input }),
  logout: () => api<{ ok: true }>('/auth/logout', { method: 'POST' }),
  me: () => api<{ user: User }>('/auth/me'),
};

export const apiKeys = {
  list: () => api<{ keys: ApiKey[] }>('/me/api-keys'),
  create: (input: { name?: string }) =>
    api<{ key: ApiKey; plaintext: string; warning: string }>('/me/api-keys', {
      method: 'POST',
      body: input,
    }),
  revoke: (keyId: string) =>
    api<{ ok: true }>(`/me/api-keys/${keyId}`, { method: 'DELETE' }),
};

export const billing = {
  plans: () => api<{ plans: Plan[] }>('/billing/plans'),
  subscription: () =>
    api<{ subscription: Subscription | null; credits: CreditState }>('/billing/subscription'),
  checkout: (plan: 'starter' | 'pro' | 'business') =>
    api<{ url: string }>('/billing/checkout', {
      method: 'POST',
      body: { plan },
    }),
};

export const usage = {
  get: () => api<UsageResponse>('/me/usage'),
};

