import { describe, it, expect, vi, beforeEach } from 'vitest';

// fetchYouTubeMetadata calls axios.get for the oEmbed endpoint. Mock the
// default export so no real network call is made. isAxiosError is provided
// so fetchYouTubeMetadataStrict can classify HTTP-status failures.
const getMock = vi.fn();
vi.mock('axios', () => ({
  default: {
    get: (...args: unknown[]) => getMock(...args),
    isAxiosError: (e: unknown): boolean =>
      typeof e === 'object' &&
      e !== null &&
      (e as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));

import {
  fetchYouTubeMetadata,
  fetchYouTubeMetadataStrict,
  mapYtDlpError,
} from './youtubeService';
import {
  NoTranscriptError,
  UpstreamBlockedError,
  VideoNotFoundError,
} from '../utils/errors';

describe('fetchYouTubeMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null title/channel/thumbnail when the oEmbed call fails', async () => {
    getMock.mockRejectedValue(new Error('HTTP 429'));
    const md = await fetchYouTubeMetadata('vid123');
    expect(md).toEqual({
      videoId: 'vid123',
      title: null,
      channel: null,
      thumbnailUrl: null,
    });
  });

  it('returns null for individual fields missing from the oEmbed response', async () => {
    getMock.mockResolvedValue({ data: { author_name: 'Some Channel' } });
    const md = await fetchYouTubeMetadata('vid123');
    expect(md.title).toBeNull();
    expect(md.channel).toBe('Some Channel');
    expect(md.thumbnailUrl).toBeNull();
  });

  it('returns the real values when the oEmbed call succeeds', async () => {
    getMock.mockResolvedValue({
      data: {
        title: 'Real Title',
        author_name: 'Real Channel',
        thumbnail_url: 'https://img/t.jpg',
      },
    });
    const md = await fetchYouTubeMetadata('vid123');
    expect(md).toEqual({
      videoId: 'vid123',
      title: 'Real Title',
      channel: 'Real Channel',
      thumbnailUrl: 'https://img/t.jpg',
    });
  });
});

describe('fetchYouTubeMetadataStrict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns real metadata when oEmbed succeeds', async () => {
    getMock.mockResolvedValue({
      data: {
        title: 'Real Title',
        author_name: 'Real Channel',
        thumbnail_url: 'https://img/t.jpg',
      },
    });
    const md = await fetchYouTubeMetadataStrict('vid123');
    expect(md).toEqual({
      videoId: 'vid123',
      title: 'Real Title',
      channel: 'Real Channel',
      thumbnailUrl: 'https://img/t.jpg',
    });
  });

  it('throws VideoNotFoundError on an oEmbed 404', async () => {
    getMock.mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
    await expect(fetchYouTubeMetadataStrict('vid123')).rejects.toBeInstanceOf(
      VideoNotFoundError,
    );
  });

  it('throws VideoNotFoundError when oEmbed answers 200 but has no title', async () => {
    // The bug: this path used to return { title: "Untitled" } and still get
    // charged a credit by the route.
    getMock.mockResolvedValue({ data: { author_name: 'Chan' } });
    await expect(fetchYouTubeMetadataStrict('vid123')).rejects.toBeInstanceOf(
      VideoNotFoundError,
    );
  });

  it('throws UpstreamBlockedError when oEmbed is rate-limited (429)', async () => {
    getMock.mockRejectedValue({ isAxiosError: true, response: { status: 429 } });
    await expect(fetchYouTubeMetadataStrict('vid123')).rejects.toBeInstanceOf(
      UpstreamBlockedError,
    );
  });
});

describe('mapYtDlpError', () => {
  it('maps a "video unavailable" failure to VideoNotFoundError', () => {
    const err = mapYtDlpError(
      { stderr: 'ERROR: [youtube] vid: Video unavailable' },
      'vid',
    );
    expect(err).toBeInstanceOf(VideoNotFoundError);
  });

  it('maps the bot-challenge failure to UpstreamBlockedError', () => {
    const err = mapYtDlpError(
      { stderr: "ERROR: Sign in to confirm you're not a bot" },
      'vid',
    );
    expect(err).toBeInstanceOf(UpstreamBlockedError);
  });

  it('maps an HTTP 429 failure to UpstreamBlockedError', () => {
    const err = mapYtDlpError(
      { stderr: 'ERROR: Unable to download: HTTP Error 429: Too Many Requests' },
      'vid',
    );
    expect(err).toBeInstanceOf(UpstreamBlockedError);
  });

  it('maps an unrecognized yt-dlp failure to UpstreamBlockedError, never NoTranscriptError', () => {
    // Regression for the core bug: a subprocess crash or a bot-challenge whose
    // wording YouTube changed used to be mislabeled NO_TRANSCRIPT — a
    // permanent error that suppressed retries and made Whisper look broken.
    const err = mapYtDlpError(
      { stderr: 'ERROR: [youtube] vid: Failed to extract any player response' },
      'vid',
    );
    expect(err).toBeInstanceOf(UpstreamBlockedError);
    expect(err).not.toBeInstanceOf(NoTranscriptError);
  });
});
