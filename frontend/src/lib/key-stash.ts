'use client';

/**
 * Browser-local cache of API key plaintexts the user has revealed during
 * this session.
 *
 * - The backend hashes keys (sha256) and only returns plaintext at creation
 *   time. So that the playground / viewer can offer a "select a key"
 *   dropdown instead of forcing the user to paste, we stash plaintexts
 *   here keyed by their server-side id.
 * - This is browser-only state. Clearing localStorage or signing out of a
 *   browser session is enough to invalidate it. Any code that reads from
 *   here MUST tolerate missing entries (the user could be on a fresh
 *   browser or have manually wiped storage).
 */

const STORAGE_KEY = 'yt-key-stash-v1';

export interface StashedKey {
  id: string;
  prefix: string | null;
  name: string | null;
  plaintext: string;
  saved_at: string;
}

function read(): StashedKey[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StashedKey[]) : [];
  } catch {
    return [];
  }
}

function write(entries: StashedKey[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function listStashedKeys(): StashedKey[] {
  return read();
}

export function getStashedKey(id: string): StashedKey | undefined {
  return read().find((k) => k.id === id);
}

export function rememberKey(input: Omit<StashedKey, 'saved_at'>): void {
  const existing = read().filter((k) => k.id !== input.id);
  existing.unshift({ ...input, saved_at: new Date().toISOString() });
  // Cap at 20 entries so localStorage doesn't grow unbounded.
  write(existing.slice(0, 20));
}

export function forgetKey(id: string): void {
  write(read().filter((k) => k.id !== id));
}

export function clearKeys(): void {
  write([]);
}
