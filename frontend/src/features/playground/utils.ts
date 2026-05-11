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
 * Build the curl snippet shown in the preview pane. Always uses the public
 * API form regardless of whether the in-browser request used the cookie
 * session — this is the code a developer would paste into their own app.
 */
export function buildCurlPreview(input: {
  firstUrl: string | null;
  format: Format;
  language: string;
  nativeOnly: boolean;
  translateTo: string;
  bearerPlaintext: string | null;
}): string {
  const params = new URLSearchParams();
  params.set('url', input.firstUrl ?? '<URL>');
  if (input.format !== 'json') params.set('format', input.format);
  if (input.language !== 'auto') params.set('language', input.language);
  if (input.nativeOnly) params.set('native_only', 'true');
  if (input.translateTo !== 'none') params.set('translate_to', input.translateTo);
  const keyPlaceholder = input.bearerPlaintext
    ? `${input.bearerPlaintext.slice(0, 12)}...`
    : 'yt_live_YOUR_KEY';
  return [
    `curl '${API_BASE_URL}/v1/transcript?${params.toString()}' \\`,
    `  -H 'Authorization: Bearer ${keyPlaceholder}'`,
  ].join('\n');
}
