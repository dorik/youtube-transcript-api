import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import { methodsEnums } from './constants';

type Method = (typeof methodsEnums)[keyof typeof methodsEnums];

// Adapter-boundary contract.
//
// `data` and `params` are typed `unknown` so service files don't silently
// leak loose payloads into components/hooks. Concrete services pass typed
// objects derived from their own input types.
//
// `transformResponse.result` is intentionally `any`. It receives the peeled
// axios body (`response.data ?? response`), which varies by endpoint between
// bare payloads and envelope shapes. Keeping the exception here avoids
// scattering unsafe casts across feature service files.
interface CreateApiOptions<TVariables, TResponse> {
  queryFn: AxiosInstance;
  request?: (variables: TVariables) => {
    url: string;
    method?: Method;
    data?: unknown;
    params?: unknown;
    config?: AxiosRequestConfig;
  };
  query?: (variables: TVariables) => {
    url: string;
    method?: Method;
    data?: unknown;
    params?: unknown;
    config?: AxiosRequestConfig;
  };
  transformResponse?: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary, see comment above.
    result: any,
    variables: TVariables,
  ) => TResponse | Promise<TResponse>;
}

export function createApi<TVariables, TResponse>({
  queryFn,
  request,
  query,
  transformResponse,
}: CreateApiOptions<TVariables, TResponse>) {
  return async (variables: TVariables): Promise<TResponse> => {
    try {
      const requestFn = request || query;
      if (!requestFn) {
        throw new Error('Either request or query must be provided');
      }
      const { url, method = methodsEnums.GET, data, params, config } = requestFn(variables);

      const response = await queryFn.request({
        url,
        method,
        data,
        params,
        ...config,
      });

      const resultData = response.data ?? response;

      if (transformResponse) {
        return transformResponse(resultData, variables);
      }

      return resultData as TResponse;
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console -- dev-only adapter diagnostic; React Query owns user-facing errors
        console.warn('createApi:', error);
      }
      throw error;
    }
  };
}
