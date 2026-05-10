import { apiClient } from '@/lib/http/client';
import { createApi } from '@/lib/http/createApi';
import { methodsEnums } from '@/lib/http/constants';
import type {
  CreateApiKeyInput,
  CreateApiKeyResponse,
  ListApiKeysResponse,
  RevokeApiKeyResponse,
} from './types';

function listApiKeysQuery() {
  return {
    url: '/me/api-keys',
    method: methodsEnums.GET,
  };
}

function createApiKeyQuery(input: CreateApiKeyInput) {
  return {
    url: '/me/api-keys',
    method: methodsEnums.POST,
    data: input,
  };
}

function revokeApiKeyQuery(keyId: string) {
  return {
    url: `/me/api-keys/${keyId}`,
    method: methodsEnums.DELETE,
  };
}

export const listApiKeys = createApi<void, ListApiKeysResponse>({
  queryFn: apiClient,
  query: listApiKeysQuery,
});

export const createApiKey = createApi<CreateApiKeyInput, CreateApiKeyResponse>({
  queryFn: apiClient,
  query: createApiKeyQuery,
});

export const revokeApiKey = createApi<string, RevokeApiKeyResponse>({
  queryFn: apiClient,
  query: revokeApiKeyQuery,
});
