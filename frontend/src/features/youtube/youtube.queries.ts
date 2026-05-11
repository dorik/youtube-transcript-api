import { useMutation } from '@tanstack/react-query';
import {
  getChannelLatest,
  getChannelVideos,
  getPlaylistVideos,
  getVideoMetadata,
  searchChannelVideos,
  searchYouTube,
} from './youtube.service';
import type {
  ChannelSearchInput,
  ChannelVideosInput,
  ChannelVideosResponse,
  PlaylistVideosInput,
  PlaylistVideosResponse,
  SearchYouTubeInput,
  SearchYouTubeResponse,
  VideoMetadataInput,
  VideoMetadataResponse,
} from './types';

export function useSearchYouTubeMutation() {
  return useMutation<SearchYouTubeResponse, Error, SearchYouTubeInput>({
    mutationFn: searchYouTube,
    meta: { suppressGlobalError: true },
  });
}

export function useChannelVideosMutation() {
  return useMutation<ChannelVideosResponse, Error, ChannelVideosInput>({
    mutationFn: getChannelVideos,
    meta: { suppressGlobalError: true },
  });
}

export function useChannelSearchMutation() {
  return useMutation<ChannelVideosResponse, Error, ChannelSearchInput>({
    mutationFn: searchChannelVideos,
    meta: { suppressGlobalError: true },
  });
}

export function useChannelLatestMutation() {
  return useMutation<ChannelVideosResponse, Error, ChannelVideosInput>({
    mutationFn: getChannelLatest,
    meta: { suppressGlobalError: true },
  });
}

export function usePlaylistVideosMutation() {
  return useMutation<PlaylistVideosResponse, Error, PlaylistVideosInput>({
    mutationFn: getPlaylistVideos,
    meta: { suppressGlobalError: true },
  });
}

export function useVideoMetadataMutation() {
  return useMutation<VideoMetadataResponse, Error, VideoMetadataInput>({
    mutationFn: getVideoMetadata,
    meta: { suppressGlobalError: true },
  });
}
