import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expandBulkSource } from './bulkExpansion';
import * as browse from './youtubeBrowseService';

vi.mock('./youtubeBrowseService');

const sampleVideo = {
  video_id: 'abc12345678',
  url: 'https://youtu.be/abc12345678',
  title: 'Sample',
  channel: 'Chan',
  channel_id: 'UC1',
  duration_text: '10:00',
  published_text: null,
  view_count_text: null,
  thumbnail_url: 'https://img/abc.jpg',
};

describe('expandBulkSource', () => {
  beforeEach(() => vi.clearAllMocks());

  it('expands a playlist and maps videos to BatchVideoInput', async () => {
    vi.mocked(browse.listPlaylistVideos).mockResolvedValue({
      playlist_id: 'PL1',
      items: [sampleVideo],
    });
    const r = await expandBulkSource({ playlist: 'PL1', limit: 5 });
    expect(r.kind).toBe('playlist');
    expect(r.sourceUrl).toBe('PL1');
    expect(r.label).toBe('PL1');
    expect(r.videos).toEqual([
      {
        url: sampleVideo.url,
        video_id: sampleVideo.video_id,
        title: 'Sample',
        channel: 'Chan',
        thumbnail_url: sampleVideo.thumbnail_url,
      },
    ]);
    expect(browse.listPlaylistVideos).toHaveBeenCalledWith({
      playlist: 'PL1',
      limit: 5,
    });
  });

  it('expands a channel in videos mode with no query', async () => {
    vi.mocked(browse.listChannelVideos).mockResolvedValue({
      channel: 'Chan',
      items: [sampleVideo],
    });
    const r = await expandBulkSource({
      channel: '@chan',
      channelMode: 'videos',
      limit: 3,
    });
    expect(r.kind).toBe('channel');
    expect(browse.listChannelVideos).toHaveBeenCalledWith({
      channel: '@chan',
      query: undefined,
      limit: 3,
    });
  });

  it('passes the query through for channel search mode', async () => {
    vi.mocked(browse.listChannelVideos).mockResolvedValue({
      channel: 'Chan',
      items: [],
    });
    await expandBulkSource({
      channel: '@chan',
      channelMode: 'search',
      channelQuery: 'review',
      limit: 3,
    });
    expect(browse.listChannelVideos).toHaveBeenCalledWith({
      channel: '@chan',
      query: 'review',
      limit: 3,
    });
  });

  it('expands a urls list and extracts video ids', async () => {
    const r = await expandBulkSource({
      urls: ['https://youtu.be/abc12345678'],
      limit: 50,
    });
    expect(r.kind).toBe('videos');
    expect(r.sourceUrl).toBeNull();
    expect(r.videos[0].video_id).toBe('abc12345678');
  });

  it('throws ValidationError for a bad url', async () => {
    await expect(
      expandBulkSource({ urls: ['not a url'], limit: 50 }),
    ).rejects.toThrow(/Invalid URL at index 0/);
  });

  it('throws when no source is provided', async () => {
    await expect(expandBulkSource({ limit: 50 })).rejects.toThrow(
      /exactly one of/,
    );
  });

  it('throws when expansion exceeds the 100-video cap', async () => {
    const many = Array.from({ length: 101 }, () => sampleVideo);
    vi.mocked(browse.listPlaylistVideos).mockResolvedValue({
      playlist_id: 'PL1',
      items: many,
    });
    await expect(
      expandBulkSource({ playlist: 'PL1', limit: 100 }),
    ).rejects.toThrow(/limit/);
  });
});
