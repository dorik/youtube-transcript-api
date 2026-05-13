import { apiClient } from '@/lib/http/client';
import { createApi } from '@/lib/http/createApi';
import { methodsEnums } from '@/lib/http/constants';
import type {
  ChannelSearchInput,
  ChannelTranscriptsInput,
  ChannelTranscriptsResponse,
  ChannelVideosInput,
  ChannelVideosResponse,
  PlaylistTranscriptsInput,
  PlaylistTranscriptsResponse,
  PlaylistVideosInput,
  PlaylistVideosResponse,
  SearchYouTubeInput,
  SearchYouTubeResponse,
  VideoMetadataInput,
  VideoMetadataResponse,
} from './types';

function authConfig(bearer: string) {
  return {
    headers: {
      Authorization: `Bearer ${bearer}`,
    },
  };
}

function searchYouTubeQuery({ bearer, ...params }: SearchYouTubeInput) {
  return {
    url: '/v1/search',
    method: methodsEnums.GET,
    params,
    config: authConfig(bearer),
  };
}

function channelVideosQuery({ bearer, ...params }: ChannelVideosInput) {
  return {
    url: '/v1/channel/videos',
    method: methodsEnums.GET,
    params,
    config: authConfig(bearer),
  };
}

function channelSearchQuery({ bearer, ...params }: ChannelSearchInput) {
  return {
    url: '/v1/channel/search',
    method: methodsEnums.GET,
    params,
    config: authConfig(bearer),
  };
}

function channelLatestQuery({ bearer, ...params }: ChannelVideosInput) {
  return {
    url: '/v1/channel/latest',
    method: methodsEnums.GET,
    params,
    config: authConfig(bearer),
  };
}

function playlistVideosQuery({ bearer, ...params }: PlaylistVideosInput) {
  return {
    url: '/v1/playlist/videos',
    method: methodsEnums.GET,
    params,
    config: authConfig(bearer),
  };
}

function videoMetadataQuery({ bearer, url }: VideoMetadataInput) {
  return {
    url: '/v1/video/metadata',
    method: methodsEnums.GET,
    params: { url },
    config: authConfig(bearer),
  };
}

function playlistTranscriptsQuery({ bearer, ...params }: PlaylistTranscriptsInput) {
  return {
    url: '/v1/playlist/transcripts',
    method: methodsEnums.GET,
    // Axios will omit `undefined` values from the query string, so unset
    // options (e.g. language, translate_to) don't appear as `=` pairs.
    params,
    config: authConfig(bearer),
  };
}

function channelTranscriptsQuery({ bearer, ...params }: ChannelTranscriptsInput) {
  return {
    url: '/v1/channel/transcripts',
    method: methodsEnums.GET,
    params,
    config: authConfig(bearer),
  };
}

export const searchYouTube = createApi<SearchYouTubeInput, SearchYouTubeResponse>({
  queryFn: apiClient,
  query: searchYouTubeQuery,
});

export const getChannelVideos = createApi<ChannelVideosInput, ChannelVideosResponse>({
  queryFn: apiClient,
  query: channelVideosQuery,
});

export const searchChannelVideos = createApi<ChannelSearchInput, ChannelVideosResponse>({
  queryFn: apiClient,
  query: channelSearchQuery,
});

export const getChannelLatest = createApi<ChannelVideosInput, ChannelVideosResponse>({
  queryFn: apiClient,
  query: channelLatestQuery,
});

export const getPlaylistVideos = createApi<PlaylistVideosInput, PlaylistVideosResponse>({
  queryFn: apiClient,
  query: playlistVideosQuery,
});

export const getVideoMetadata = createApi<VideoMetadataInput, VideoMetadataResponse>({
  queryFn: apiClient,
  query: videoMetadataQuery,
});

export const getPlaylistTranscripts = createApi<
  PlaylistTranscriptsInput,
  PlaylistTranscriptsResponse
>({
  queryFn: apiClient,
  query: playlistTranscriptsQuery,
});

export const getChannelTranscripts = createApi<
  ChannelTranscriptsInput,
  ChannelTranscriptsResponse
>({
  queryFn: apiClient,
  query: channelTranscriptsQuery,
});
