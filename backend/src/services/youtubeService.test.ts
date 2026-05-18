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
  pickCaptionTrack,
  withYtDlpRetry,
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

describe('withYtDlpRetry', () => {
  // A flaky residential-proxy exit dropping the TLS handshake — mapYtDlpError
  // matches none of its permanent patterns, so it classifies as transient.
  const sslFail = () =>
    Promise.reject({
      stderr:
        'ERROR: Unable to download API page: [SSL: UNEXPECTED_EOF_WHILE_READING]',
    });

  it('returns the result without retrying when the first attempt succeeds', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '' });
    await expect(withYtDlpRetry(run, 'vid')).resolves.toEqual({
      stdout: 'ok',
      stderr: '',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure on a fresh attempt and then succeeds', async () => {
    const run = vi
      .fn()
      .mockImplementationOnce(sslFail)
      .mockResolvedValueOnce({ stdout: 'ok', stderr: '' });
    await expect(withYtDlpRetry(run, 'vid')).resolves.toEqual({
      stdout: 'ok',
      stderr: '',
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt cap and throws UpstreamBlockedError', async () => {
    const run = vi.fn().mockImplementation(sslFail);
    await expect(withYtDlpRetry(run, 'vid')).rejects.toBeInstanceOf(
      UpstreamBlockedError,
    );
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('never retries a permanent failure — a removed video fails on attempt 1', async () => {
    const run = vi
      .fn()
      .mockRejectedValue({ stderr: 'ERROR: [youtube] vid: Video unavailable' });
    await expect(withYtDlpRetry(run, 'vid')).rejects.toBeInstanceOf(
      VideoNotFoundError,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('pickCaptionTrack', () => {
  // Mirrors yt-dlp's real `automatic_captions` shape: ~150 machine-TRANSLATED
  // variants — whose timed-text URL carries `tlang=` — keyed by bare target
  // code and listed alphabetically AHEAD of the genuine source-language track.
  // Regression for video AtnMG_40604, where the translated `ab` (Abkhazian)
  // track was picked and YouTube 429'd the translate endpoint.
  const TT = 'https://www.youtube.com/api/timedtext?v=vid&fmt=json3';
  const json3 = (url: string) => [{ ext: 'json3', url }];
  const dump = {
    id: 'vid',
    subtitles: {},
    automatic_captions: {
      ab: json3(`${TT}&lang=bn&tlang=ab`),
      aa: json3(`${TT}&lang=bn&tlang=aa`),
      'bn-orig': json3(`${TT}&lang=bn`),
      bn: json3(`${TT}&lang=bn`),
      en: json3(`${TT}&lang=bn&tlang=en`),
    },
  };

  it('skips machine-translated tracks and picks the genuine source track', () => {
    const pick = pickCaptionTrack(dump, undefined);
    expect(pick).not.toBeNull();
    expect(pick!.url).not.toMatch(/tlang=/);
  });

  it('falls back to a genuine track when the requested language exists only as a translation target', () => {
    // `en` is present only as a bn->en translation; picking it would fetch the
    // rate-limited translate endpoint. Must fall through to a genuine track.
    const pick = pickCaptionTrack(dump, 'en');
    expect(pick).not.toBeNull();
    expect(pick!.url).not.toMatch(/tlang=/);
  });
});
