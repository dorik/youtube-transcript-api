/**
 * Shared display helpers for dates, durations, and timecodes.
 *
 * These used to live as private copies in three different feature
 * folders (`dashboard/page.tsx`, `transcripts-history/utils.ts`,
 * `transcript-viewer/utils.ts`, `playground/utils.ts`). Consolidated
 * here per CLAUDE.md §7.3 ("Pure utilities belong in `app/lib/`").
 */

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Render `seconds` as a video-style timecode:
 *
 *   54     → "0:54"
 *   125    → "2:05"
 *   3725   → "1:02:05"
 *
 * Always uses `Math.floor` (a playback cursor at 59.6s shows `0:59`,
 * not `1:00`). Hours are omitted entirely when zero.
 */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/**
 * Coarse "X ago" string with locale-date fallback past 30 days.
 *
 *   30s   → "just now"
 *   12m   → "12m ago"
 *   3h    → "3h ago"
 *   5d    → "5d ago"
 *   60d   → "2024-04-08" (or whatever toLocaleDateString returns)
 */
export function formatRelativeTime(iso: string): string {
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

/** Locale-formatted date (no time). */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}
