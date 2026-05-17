import { API_BASE_URL } from '@/lib/api';
import type { Format } from './types';

export function parseVideoLines(text: string): Array<{ url: string }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((url) => ({ url }));
}

export function shortVideoId(url: string): string {
  const m =
    url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ??
    url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ??
    url.match(/\/embed\/([a-zA-Z0-9_-]{11})/) ??
    url.match(/^([a-zA-Z0-9_-]{11})$/);
  return m ? m[1] : url.slice(0, 14) + (url.length > 14 ? '…' : '');
}

interface TranscriptOpts {
  format: Format;
  language: string;
  nativeOnly: boolean;
  translateTo: string;
  bearerPlaintext: string | null;
}

/** Curl-preview input — one variant per playground tab. */
export type CurlPreviewInput = (
  | { mode: 'video'; firstUrl: string | null }
  | { mode: 'playlist'; playlist: string; limit: number }
  | {
      mode: 'channel';
      channel: string;
      channelMode: 'videos' | 'latest' | 'search';
      channelQuery: string;
      limit: number;
    }
) &
  TranscriptOpts;

function bearerHeader(bearerPlaintext: string | null): string {
  const keyPlaceholder = bearerPlaintext
    ? `${bearerPlaintext.slice(0, 12)}...`
    : 'yt_live_YOUR_KEY';
  return `  -H 'Authorization: Bearer ${keyPlaceholder}'`;
}

/** Add the shared transcript options to a request body, omitting defaults. */
function withTranscriptOpts(
  body: Record<string, unknown>,
  opts: TranscriptOpts,
): Record<string, unknown> {
  if (opts.format !== 'json') body.format = opts.format;
  if (opts.language !== 'auto') body.language = opts.language;
  if (opts.nativeOnly) body.native_only = true;
  if (opts.translateTo !== 'none') body.translate_to = opts.translateTo;
  return body;
}

function curl(path: string, body: Record<string, unknown>, bearer: string | null): string {
  return [
    `curl -X POST '${API_BASE_URL}${path}' \\`,
    bearerHeader(bearer) + ` \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${JSON.stringify(body)}'`,
  ].join('\n');
}

/**
 * Build the curl snippet for the active tab. The Videos tab hits
 * POST /v1/transcript; the Playlist/Channel tabs hit POST /v1/transcripts/bulk
 * (which returns queued entries the caller then polls).
 */
export function buildCurlPreview(input: CurlPreviewInput): string {
  if (input.mode === 'video') {
    const body = withTranscriptOpts(
      { url: input.firstUrl ?? '<URL>' },
      input,
    );
    return curl('/v1/transcript', body, input.bearerPlaintext);
  }
  if (input.mode === 'playlist') {
    const body = withTranscriptOpts(
      { playlist: input.playlist || '<PLAYLIST_URL>', limit: input.limit },
      input,
    );
    return curl('/v1/transcripts/bulk', body, input.bearerPlaintext);
  }
  const body: Record<string, unknown> = {
    channel: input.channel || '<CHANNEL_URL>',
    channelMode: input.channelMode,
    limit: input.limit,
  };
  if (input.channelMode === 'search') {
    body.channelQuery = input.channelQuery || '<QUERY>';
  }
  return curl('/v1/transcripts/bulk', withTranscriptOpts(body, input), input.bearerPlaintext);
}
