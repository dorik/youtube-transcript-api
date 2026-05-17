import { listPlaylistVideos, listChannelVideos } from './youtubeBrowseService';
import type { BrowseVideo } from './youtubeBrowseService';
import { extractVideoId } from '../utils/youtubeUrl';
import { ValidationError } from '../utils/errors';
import { BATCH_VIDEO_CAP } from './transcriptRequestService';
import type { BatchVideoInput } from './transcriptRequestService';

/** Channel expansion modes. `videos`/`latest` list the channel's uploads;
 *  `search` runs a keyword search within the channel. */
export type ChannelMode = 'videos' | 'latest' | 'search';

export interface BulkExpansionInput {
  playlist?: string;
  channel?: string;
  channelMode?: ChannelMode;
  channelQuery?: string;
  urls?: string[];
  limit: number;
}

export interface BulkExpansionResult {
  kind: 'playlist' | 'channel' | 'videos';
  sourceUrl: string | null;
  label: string | null;
  videos: BatchVideoInput[];
}

function toBatchVideo(v: BrowseVideo): BatchVideoInput {
  return {
    url: v.url,
    video_id: v.video_id,
    title: v.title,
    channel: v.channel,
    thumbnail_url: v.thumbnail_url,
  };
}

function assertWithinCap(count: number): void {
  if (count > BATCH_VIDEO_CAP) {
    throw new ValidationError(
      `Batch exceeds the ${BATCH_VIDEO_CAP}-video limit (${count} videos).`,
    );
  }
}

/**
 * Resolve a bulk request's source (playlist / channel / explicit URLs) into a
 * video list ready for `enqueueBatch`. Throws `ValidationError` for a bad URL,
 * an over-cap result, or a missing source. `videos`/`latest` both list the
 * channel's uploads (the browse service treats them identically); `search`
 * adds the keyword query.
 */
export async function expandBulkSource(
  input: BulkExpansionInput,
): Promise<BulkExpansionResult> {
  if (input.playlist) {
    const listing = await listPlaylistVideos({
      playlist: input.playlist,
      limit: input.limit,
    });
    const videos = listing.items.map(toBatchVideo);
    assertWithinCap(videos.length);
    return {
      kind: 'playlist',
      sourceUrl: input.playlist,
      label: input.playlist,
      videos,
    };
  }

  if (input.channel) {
    const query =
      input.channelMode === 'search' ? input.channelQuery : undefined;
    const listing = await listChannelVideos({
      channel: input.channel,
      query,
      limit: input.limit,
    });
    const videos = listing.items.map(toBatchVideo);
    assertWithinCap(videos.length);
    return {
      kind: 'channel',
      sourceUrl: input.channel,
      label: input.channel,
      videos,
    };
  }

  if (input.urls && input.urls.length > 0) {
    const videos = input.urls.map((url, index) => {
      try {
        return { url, video_id: extractVideoId(url) };
      } catch {
        throw new ValidationError(`Invalid URL at index ${index}: ${url}`);
      }
    });
    assertWithinCap(videos.length);
    return { kind: 'videos', sourceUrl: null, label: null, videos };
  }

  throw new ValidationError('Provide exactly one of: playlist, channel, urls');
}
