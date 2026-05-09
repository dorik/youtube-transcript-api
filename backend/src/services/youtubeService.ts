import {
  YoutubeTranscript,
  type TranscriptResponse,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
  YoutubeTranscriptTooManyRequestError,
} from 'youtube-transcript';
import axios from 'axios';
import { config } from '../config/env';
import { logger } from '../config/logger';
import {
  NoTranscriptError,
  RateLimitError,
  VideoNotFoundError,
} from '../utils/errors';
import { Segment } from './formatters';

export interface YouTubeFetchResult {
  videoId: string;
  segments: Segment[];
  language: string;
  durationSeconds: number;
  source: 'native_captions';
}

export interface YouTubeMetadata {
  videoId: string;
  title: string;
  channel: string;
  thumbnailUrl: string | null;
}

/**
 * Fetch native YouTube captions for a video.
 *
 * - When `language` is undefined or 'auto', the library picks whatever the
 *   video's default language is.
 * - When `STUB_PROXY=false` we'd inject a proxy-aware fetch; for MVP we use
 *   the default Node fetch. The hook is here so dropping in a real proxy is
 *   a one-line change.
 *
 * Throws:
 * - `NoTranscriptError` — captions are disabled or unavailable. Caller may
 *   fall back to Whisper.
 * - `VideoNotFoundError` — video does not exist / private / removed.
 * - `RateLimitError` — YouTube is throttling us (proxy needs rotation).
 */
export async function fetchYouTubeCaptions(
  videoId: string,
  language?: string,
): Promise<YouTubeFetchResult> {
  // Normalize: 'auto' or empty string means "let YouTube pick its default
  // track" — pass `undefined` to the library, which uses captionTracks[0].
  const requestedLang =
    language && language !== 'auto' && language.trim() ? language : undefined;

  try {
    const responses = await tryFetch(videoId, requestedLang);

    if (!responses.length) {
      throw new NoTranscriptError(videoId);
    }

    // youtube-transcript returns offset/duration in MILLISECONDS. Our pipeline
    // (Segment, formatters, credit math) is uniformly in seconds.
    const segments: Segment[] = responses.map((r: TranscriptResponse) => ({
      start: typeof r.offset === 'number' ? r.offset / 1000 : 0,
      duration: typeof r.duration === 'number' ? r.duration / 1000 : 0,
      text: decodeHtmlEntities(r.text),
    }));

    const last = segments[segments.length - 1];
    const durationSeconds = Math.ceil((last.start + last.duration) || 0);

    return {
      videoId,
      segments,
      // Use whatever language the library actually returned (e.g. 'bn' for a
      // Bangla video the user requested as 'auto'). Falls back to the
      // requested code if for some reason the response doesn't carry one.
      language: responses[0].lang ?? requestedLang ?? language ?? 'en',
      durationSeconds,
      source: 'native_captions',
    };
  } catch (err) {
    if (
      err instanceof YoutubeTranscriptDisabledError ||
      err instanceof YoutubeTranscriptNotAvailableError ||
      err instanceof YoutubeTranscriptNotAvailableLanguageError
    ) {
      // Captions either don't exist OR every available language was
      // exhausted by the retry inside tryFetch. Either way the caller
      // should treat this as "no native transcript".
      throw new NoTranscriptError(videoId);
    }
    if (err instanceof YoutubeTranscriptVideoUnavailableError) {
      throw new VideoNotFoundError(videoId);
    }
    if (err instanceof YoutubeTranscriptTooManyRequestError) {
      throw new RateLimitError(60);
    }
    throw err;
  }
}

/**
 * Wrap `YoutubeTranscript.fetchTranscript` with one retry: if the requested
 * language isn't available but other tracks exist, fall back to the first
 * available track instead of giving up.
 *
 * Without this, asking for 'en' on a Bangla-only video throws
 * `NotAvailableLanguageError` and the caller falls back to Whisper, which
 * isn't what the user wants — they'd take the Bangla transcript happily.
 */
async function tryFetch(
  videoId: string,
  requestedLang: string | undefined,
): Promise<TranscriptResponse[]> {
  const fetchOpts = {
    fetch: config.STUB_PROXY ? undefined : globalThis.fetch,
  };

  try {
    return await YoutubeTranscript.fetchTranscript(videoId, {
      ...fetchOpts,
      lang: requestedLang,
    });
  } catch (err) {
    if (!(err instanceof YoutubeTranscriptNotAvailableLanguageError)) throw err;

    // The library doesn't expose `availableLangs` as a field, but it
    // formats them into the error message: "Available languages: en, bn".
    const match = /Available languages:\s*(.+)$/i.exec(err.message);
    const available =
      match?.[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [];

    if (available.length === 0) throw err;

    const fallback = available[0];
    logger.info(
      { videoId, requested: requestedLang, available, fallback },
      'Requested caption language unavailable; retrying with first available track',
    );
    return await YoutubeTranscript.fetchTranscript(videoId, {
      ...fetchOpts,
      lang: fallback,
    });
  }
}

/**
 * Fetch lightweight video metadata via oEmbed. No API key required.
 *
 * oEmbed gives us title + author + thumbnail but NOT duration; for native
 * captions we infer duration from segments. For Whisper, duration comes
 * from ffprobe on the downloaded audio.
 */
export async function fetchYouTubeMetadata(
  videoId: string,
): Promise<YouTubeMetadata> {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const { data } = await axios.get(url, { timeout: 8_000 });
    return {
      videoId,
      title: typeof data.title === 'string' ? data.title : 'Untitled',
      channel: typeof data.author_name === 'string' ? data.author_name : 'Unknown',
      thumbnailUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : null,
    };
  } catch (err) {
    logger.warn({ err, videoId }, 'oEmbed metadata fetch failed; using placeholders');
    return {
      videoId,
      title: 'Untitled',
      channel: 'Unknown',
      thumbnailUrl: null,
    };
  }
}

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
}
