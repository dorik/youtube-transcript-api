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

// ---------------------------------------------------------------------------
// Bulk transcripts — playlist / channel one-call endpoints.
//
// One HTTP call expands the source list and returns N transcripts (or per-
// item errors). Server-side concurrency is bounded to 5, so the response
// time scales sub-linearly with `limit` (capped at 20 server-side).
// ---------------------------------------------------------------------------

import type { TranscriptResponse } from '@/lib/api';

export type ChannelTranscriptsMode = 'latest' | 'videos' | 'search';

interface BulkTranscriptCommonOptions {
  bearer: string;
  limit?: number;
  format?: 'json' | 'text' | 'srt' | 'vtt' | 'text-timestamps';
  language?: string;
  native_only?: boolean;
  translate_to?: string;
}

export interface PlaylistTranscriptsInput extends BulkTranscriptCommonOptions {
  playlist: string;
}

export interface ChannelTranscriptsInput extends BulkTranscriptCommonOptions {
  channel: string;
  mode?: ChannelTranscriptsMode;
  q?: string;
}

export interface BulkTranscriptError {
  code: string;
  message: string;
}

export interface BulkTranscriptItem {
  url: string;
  video_id: string | null;
  title: string | null;
  channel: string | null;
  thumbnail_url: string | null;
  duration_text: string | null;
  ok: boolean;
  /** Populated when ok === true. */
  transcript?: TranscriptResponse;
  /** Populated when ok === false. */
  error?: BulkTranscriptError;
}

export interface PlaylistTranscriptsResponse {
  playlist_id: string;
  items: BulkTranscriptItem[];
  total: number;
  succeeded: number;
  failed: number;
  credits_used: number;
}

export interface ChannelTranscriptsResponse {
  channel: string;
  mode: ChannelTranscriptsMode;
  /** Only present when mode === 'search'. */
  query?: string;
  items: BulkTranscriptItem[];
  total: number;
  succeeded: number;
  failed: number;
  credits_used: number;
}
