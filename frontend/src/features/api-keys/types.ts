import type { ApiKey } from '@/lib/api';

export interface ListApiKeysResponse {
  keys: ApiKey[];
}

export interface CreateApiKeyInput {
  name?: string;
}

export interface CreateApiKeyResponse {
  key: ApiKey;
  plaintext: string;
  warning: string;
}

export interface RevokeApiKeyResponse {
  ok: true;
}
