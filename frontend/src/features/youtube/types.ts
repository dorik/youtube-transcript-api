export type YouTubeSearchType = 'video' | 'channel' | 'playlist' | 'all';

export interface BrowseVideo {
  video_id: string;
  url: string;
  title: string;
  channel: string | null;
  channel_id: string | null;
  duration_text: string | null;
  published_text: string | null;
  view_count_text: string | null;
  thumbnail_url: string | null;
}

export interface BrowseChannel {
  channel_id: string;
  url: string;
  title: string;
  handle: string | null;
  subscriber_count_text: string | null;
  thumbnail_url: string | null;
}

export interface BrowsePlaylist {
  playlist_id: string;
  url: string;
  title: string;
  channel: string | null;
  video_count_text: string | null;
  thumbnail_url: string | null;
}

export interface SearchYouTubeInput {
  bearer: string;
  q: string;
  type?: YouTubeSearchType;
  limit?: number;
}

export interface SearchYouTubeResponse {
  query: string;
  type: YouTubeSearchType;
  items: Array<BrowseVideo | BrowseChannel | BrowsePlaylist>;
  credits_used: number;
}

export interface ChannelVideosInput {
  bearer: string;
  channel: string;
  limit?: number;
}

export interface ChannelSearchInput extends ChannelVideosInput {
  q: string;
}

export interface ChannelVideosResponse {
  channel: string;
  items: BrowseVideo[];
  query?: string;
  credits_used: number;
}

export interface PlaylistVideosInput {
  bearer: string;
  playlist: string;
  limit?: number;
}

export interface PlaylistVideosResponse {
  playlist_id: string;
  items: BrowseVideo[];
  credits_used: number;
}

export interface VideoMetadataInput {
  bearer: string;
  url: string;
}

export interface VideoMetadataResponse {
  video_id: string;
  url: string;
  title: string;
  channel: string;
  description: string | null;
  duration_seconds: number | null;
  view_count: number | null;
  thumbnail_url: string | null;
  credits_used: number;
}
