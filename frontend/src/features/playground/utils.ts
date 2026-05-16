import { API_BASE_URL } from '@/lib/api';
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
 * Options shared across all curl preview variants.
 */
interface TranscriptOpts {
  format: Format;
  language: string;
  nativeOnly: boolean;
  translateTo: string;
  bearerPlaintext: string | null;
}

/**
 * Discriminated input for `buildCurlPreview`. Only the `video` mode remains
 * now that the playlist/channel bulk endpoints have been removed from the
 * backend.
 */
export type CurlPreviewInput = {
  mode: 'video';
  firstUrl: string | null;
} & TranscriptOpts;

function bearerHeader(bearerPlaintext: string | null): string {
  const keyPlaceholder = bearerPlaintext
    ? `${bearerPlaintext.slice(0, 12)}...`
    : 'yt_live_YOUR_KEY';
  return `  -H 'Authorization: Bearer ${keyPlaceholder}'`;
}

/**
 * Build a JSON body object for the POST /v1/transcript curl snippet, omitting
 * fields that are at their defaults so the snippet stays minimal.
 */
function buildTranscriptBody(
  url: string,
  opts: TranscriptOpts,
): Record<string, unknown> {
  const body: Record<string, unknown> = { url };
  if (opts.format !== 'json') body.format = opts.format;
  if (opts.language !== 'auto') body.language = opts.language;
  if (opts.nativeOnly) body.native_only = true;
  if (opts.translateTo !== 'none') body.translate_to = opts.translateTo;
  return body;
}

/**
 * Build the curl snippet shown in the preview pane. Always uses the public
 * API form regardless of whether the in-browser request used the cookie
 * session — this is the code a developer would paste into their own app.
 *
 * POST /v1/transcript enqueues the request and returns a TranscriptRequest;
 * poll GET /v1/transcript/:id until status is `completed` or `failed`.
 */
export function buildCurlPreview(input: CurlPreviewInput): string {
  const body = buildTranscriptBody(input.firstUrl ?? '<URL>', input);
  return [
    `curl -X POST '${API_BASE_URL}/v1/transcript' \\`,
    bearerHeader(input.bearerPlaintext) + ` \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${JSON.stringify(body)}'`,
  ].join('\n');
}
