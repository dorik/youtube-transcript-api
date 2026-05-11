import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from './api-keys.service';
import type {
  CreateApiKeyInput,
  CreateApiKeyResponse,
  ListApiKeysResponse,
  RevokeApiKeyResponse,
} from './types';
import { apiKeysQueryKeys } from './queryKeys';

export function useApiKeysQuery() {
  return useQuery<ListApiKeysResponse, Error>({
    queryKey: apiKeysQueryKeys.list(),
    queryFn: () => listApiKeys(),
  });
}

export function useCreateApiKeyMutation() {
  const queryClient = useQueryClient();

  return useMutation<CreateApiKeyResponse, Error, CreateApiKeyInput>({
    mutationFn: createApiKey,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeysQueryKeys.list() });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const queryClient = useQueryClient();

  return useMutation<RevokeApiKeyResponse, Error, string>({
    mutationFn: revokeApiKey,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeysQueryKeys.list() });
    },
  });
}
