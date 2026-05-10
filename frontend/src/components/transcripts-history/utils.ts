/**
 * Pure helpers for the transcripts history list.
 */

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Format seconds as `m:ss` or `h:mm:ss`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/**
 * Render an ISO timestamp as a coarse "X ago" string. Falls back to
 * locale-formatted date past 30 days. Computed eagerly each call —
 * callers should memoize at the row level (React.memo is enough since
 * the iso string is stable per row).
 */
export function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
