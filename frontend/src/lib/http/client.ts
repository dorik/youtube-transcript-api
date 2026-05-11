import axios from 'axios';
import type { AxiosError } from 'axios';
import { API_BASE_URL, ApiError } from '@/lib/api';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const status = error.response?.status ?? 0;
    const data = error.response?.data;
    const env = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};

    throw new ApiError(
      status,
      typeof env.code === 'string' ? env.code : 'UNKNOWN',
      typeof env.message === 'string' ? env.message : error.message,
      env,
    );
  },
);
