import { describe, it, expect, vi, beforeEach } from 'vitest';

// fetchYouTubeMetadata calls axios.get for the oEmbed endpoint. Mock the
// default export so no real network call is made.
const getMock = vi.fn();
vi.mock('axios', () => ({
  default: { get: (...args: unknown[]) => getMock(...args) },
}));

import { fetchYouTubeMetadata } from './youtubeService';

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
