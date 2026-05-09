import { ValidationError } from './errors';

/**
 * Extract a YouTube video ID from any of the common URL shapes:
 *   https://www.youtube.com/watch?v=ID
 *   https://youtu.be/ID
 *   https://www.youtube.com/embed/ID
 *   https://www.youtube.com/shorts/ID
 *   https://m.youtube.com/watch?v=ID
 *   ID (already-bare 11-char id)
 */
const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

const URL_PATTERNS: RegExp[] = [
  /(?:youtube\.com|youtube-nocookie\.com)\/watch\?(?:[^&]*&)*v=([a-zA-Z0-9_-]{11})/,
  /youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
];

export function extractVideoId(input: string): string {
  const trimmed = input.trim();
  if (ID_RE.test(trimmed)) return trimmed;
  for (const pattern of URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }
  throw new ValidationError('Could not extract a YouTube video ID from the supplied url', {
    url: trimmed,
  });
}

export function buildWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
