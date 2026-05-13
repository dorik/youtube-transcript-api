import type { UsageRecentEntry } from '@/lib/api';

/**
 * Classify an `api_requests` row by its endpoint so the Recent activity /
 * Recent requests tables can render bulk / discovery / single-video rows
 * distinctly. Bulk endpoints (one HTTP call → N transcripts) and discovery
 * endpoints (list video IDs, no transcripts) both write rows with
 * `video_id` / `transcript_source` NULL, which used to render as blank
 * "—" / "—". Knowing the row's *kind* lets us surface something meaningful.
 */
export type RowKind =
  | 'transcript' // /v1/transcript or /me/transcript — single video
  | 'bulk-playlist' // /v1/playlist/transcripts
  | 'bulk-channel' // /v1/channel/transcripts
  | 'discovery' // /v1/search, /v1/{channel,playlist}/*, /v1/video/metadata
  | 'other';

export function classifyRow(endpoint: string): RowKind {
  if (endpoint === '/v1/playlist/transcripts') return 'bulk-playlist';
  if (endpoint === '/v1/channel/transcripts') return 'bulk-channel';
  if (endpoint === '/v1/transcript' || endpoint === '/me/transcript')
    return 'transcript';
  if (endpoint.startsWith('/v1/')) return 'discovery';
  return 'other';
}

/**
 * Video column. Single-video rows show the 11-char id. Bulk/discovery rows
 * don't *have* a single video id, so we show a short label instead of "—"
 * (which left users wondering what the row was for).
 */
export function VideoCell({ row }: { row: UsageRecentEntry }) {
  if (row.video_id) return <>{row.video_id}</>;
  const kind = classifyRow(row.endpoint);
  if (kind === 'bulk-playlist')
    return <span className="text-muted-foreground">playlist</span>;
  if (kind === 'bulk-channel')
    return <span className="text-muted-foreground">channel</span>;
  if (kind === 'discovery')
    return <span className="text-muted-foreground">discovery</span>;
  return <>—</>;
}

/**
 * Source column. For single-video transcripts we show which fetcher
 * produced it ("OpenAI" / "native"). For bulk endpoints we show what kind
 * of bulk call it was, since no single transcript_source applies. Failed
 * rows take precedence and surface the error code.
 *
 * Cache-hit is intentionally not surfaced here — the Credits column tells
 * that story (0 for a cache hit, 1 for fresh work).
 */
export function SourceCell({ row }: { row: UsageRecentEntry }) {
  if (row.status_code >= 400) {
    return (
      <span className="font-mono text-xs text-red-700">
        {row.error_code ?? 'error'}
      </span>
    );
  }

  const kind = classifyRow(row.endpoint);
  if (kind === 'bulk-playlist') return <span>Bulk · playlist</span>;
  if (kind === 'bulk-channel') return <span>Bulk · channel</span>;
  if (kind === 'discovery') return <span>Discovery</span>;

  // Single-video transcript path. Whisper is labelled "OpenAI" in the UI
  // because that's the service name the user recognizes; the stored value
  // in `api_requests.transcript_source` stays `'whisper'` so dashboards /
  // queries keep working.
  const sourceLabel =
    row.transcript_source === 'whisper'
      ? 'OpenAI'
      : row.transcript_source === 'native_captions'
        ? 'native'
        : null;

  return <span>{sourceLabel ?? '—'}</span>;
}

/**
 * Format column. Single-video and bulk-transcript rows have a `format`
 * (json/text/srt/vtt). Discovery rows don't — format is a transcript-only
 * concept — so we render a dash.
 */
export function FormatCell({ row }: { row: UsageRecentEntry }) {
  if (row.format) return <>{row.format}</>;
  return <span className="text-muted-foreground">—</span>;
}
