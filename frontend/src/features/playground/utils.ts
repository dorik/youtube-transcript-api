import { API_BASE_URL } from '@/lib/api';
import type { BrowseVideo } from '@/features/youtube';
import type { Format } from './types';

/**
 * Parse the bulk URL textarea: one URL/id per line, blank lines dropped.
 */
export function parseVideoLines(text: string): Array<{ url: string }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((url) => ({ url }));
}

/** Convert BrowseVideo[] (from playlist/channel results) to bulk-input rows. */
export function videosToUrls(videos: BrowseVideo[]): Array<{ url: string }> {
  return videos.map((video) => ({ url: video.url }));
}

/**
 * Pull a video id out of a YouTube URL for use as a tab label. Falls back
 * to the truncated raw URL if we can't recognize a known pattern.
 */
export function shortVideoId(url: string): string {
  const m =
    url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ??
    url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ??
    url.match(/\/embed\/([a-zA-Z0-9_-]{11})/) ??
    url.match(/^([a-zA-Z0-9_-]{11})$/);
  return m ? m[1] : url.slice(0, 14) + (url.length > 14 ? '…' : '');
}

/**
 * Discriminated input for `buildCurlPreview` — one variant per playground
 * tab / channel sub-mode. All variants point at the endpoint the playground
 * actually hits when the user submits, so the snippet is copy-paste-ready:
 *
 *   - video  → `/v1/transcript`         (one transcript per call)
 *   - playlist / channel-* → `/v1/playlist/transcripts` or
 *     `/v1/channel/transcripts`         (server-side bulk: expansion + N
 *                                        transcripts in one HTTP call).
 *
 * The transcript options (`format`, `language`, `nativeOnly`, `translateTo`)
 * are shared across video and bulk variants because the bulk endpoints
 * accept the same per-item options.
 */
interface BulkTranscriptOpts {
  format: Format;
  language: string;
  nativeOnly: boolean;
  translateTo: string;
  bearerPlaintext: string | null;
}

export type CurlPreviewInput =
  | ({
      mode: 'video';
      firstUrl: string | null;
    } & BulkTranscriptOpts)
  | ({
      mode: 'playlist';
      playlist: string;
      limit: number;
    } & BulkTranscriptOpts)
  | ({
      mode: 'channel-videos';
      channel: string;
      limit: number;
    } & BulkTranscriptOpts)
  | ({
      mode: 'channel-latest';
      channel: string;
      limit: number;
    } & BulkTranscriptOpts)
  | ({
      mode: 'channel-search';
      channel: string;
      query: string;
      limit: number;
    } & BulkTranscriptOpts);

function bearerHeader(bearerPlaintext: string | null): string {
  const keyPlaceholder = bearerPlaintext
    ? `${bearerPlaintext.slice(0, 12)}...`
    : 'yt_live_YOUR_KEY';
  return `  -H 'Authorization: Bearer ${keyPlaceholder}'`;
}

/**
 * Append transcript-option params (format, language, native_only,
 * translate_to) to a URLSearchParams, skipping defaults so the snippet stays
 * minimal. Used by both the single-video and the bulk variants since the
 * bulk endpoints accept the same per-item options.
 */
function appendTranscriptOpts(params: URLSearchParams, opts: BulkTranscriptOpts) {
  if (opts.format !== 'json') params.set('format', opts.format);
  if (opts.language !== 'auto') params.set('language', opts.language);
  if (opts.nativeOnly) params.set('native_only', 'true');
  if (opts.translateTo !== 'none') params.set('translate_to', opts.translateTo);
}

/**
 * Build the curl snippet shown in the preview pane. Always uses the public
 * API form regardless of whether the in-browser request used the cookie
 * session — this is the code a developer would paste into their own app.
 *
 * For playlist/channel modes the snippet hits the matching browse endpoint
 * (`/v1/playlist/videos`, `/v1/channel/videos|latest|search`). Those return
 * `{ items: [...] }`; expanding each item into a per-video transcript call
 * is the caller's job — kept out of the preview to stay readable.
 */
export function buildCurlPreview(input: CurlPreviewInput): string {
  switch (input.mode) {
    case 'video': {
      const params = new URLSearchParams();
      params.set('url', input.firstUrl ?? '<URL>');
      appendTranscriptOpts(params, input);
      return [
        `curl '${API_BASE_URL}/v1/transcript?${params.toString()}' \\`,
        bearerHeader(input.bearerPlaintext),
      ].join('\n');
    }
    case 'playlist': {
      const params = new URLSearchParams();
      params.set('playlist', input.playlist || '<PLAYLIST_URL_OR_ID>');
      params.set('limit', String(input.limit));
      appendTranscriptOpts(params, input);
      return [
        `curl '${API_BASE_URL}/v1/playlist/transcripts?${params.toString()}' \\`,
        bearerHeader(input.bearerPlaintext),
      ].join('\n');
    }
    case 'channel-videos': {
      const params = new URLSearchParams();
      params.set('channel', input.channel || '<CHANNEL_URL_ID_OR_HANDLE>');
      params.set('mode', 'videos');
      params.set('limit', String(input.limit));
      appendTranscriptOpts(params, input);
      return [
        `curl '${API_BASE_URL}/v1/channel/transcripts?${params.toString()}' \\`,
        bearerHeader(input.bearerPlaintext),
      ].join('\n');
    }
    case 'channel-latest': {
      const params = new URLSearchParams();
      params.set('channel', input.channel || '<CHANNEL_URL_ID_OR_HANDLE>');
      // `mode=latest` is the default; omit it to keep the URL short.
      params.set('limit', String(input.limit));
      appendTranscriptOpts(params, input);
      return [
        `curl '${API_BASE_URL}/v1/channel/transcripts?${params.toString()}' \\`,
        bearerHeader(input.bearerPlaintext),
      ].join('\n');
    }
    case 'channel-search': {
      const params = new URLSearchParams();
      params.set('channel', input.channel || '<CHANNEL_URL_ID_OR_HANDLE>');
      params.set('mode', 'search');
      params.set('q', input.query || '<QUERY>');
      params.set('limit', String(input.limit));
      appendTranscriptOpts(params, input);
      return [
        `curl '${API_BASE_URL}/v1/channel/transcripts?${params.toString()}' \\`,
        bearerHeader(input.bearerPlaintext),
      ].join('\n');
    }
  }
}
