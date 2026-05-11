import { apiClient } from '@/lib/http/client';
import { createApi } from '@/lib/http/createApi';
import { methodsEnums } from '@/lib/http/constants';
import type {
  AuthUserResponse,
  LoginInput,
  LogoutResponse,
  SignupInput,
} from './types';

function getCurrentUserQuery() {
  return {
    url: '/auth/me',
    method: methodsEnums.GET,
  };
}

function loginQuery(input: LoginInput) {
  return {
    url: '/auth/login',
    method: methodsEnums.POST,
    data: input,
  };
}

function signupQuery(input: SignupInput) {
  return {
    url: '/auth/signup',
    method: methodsEnums.POST,
    data: input,
  };
}

function logoutQuery() {
  return {
    url: '/auth/logout',
    method: methodsEnums.POST,
  };
}

export const getCurrentUser = createApi<void, AuthUserResponse>({
  queryFn: apiClient,
  query: getCurrentUserQuery,
});

export const login = createApi<LoginInput, AuthUserResponse>({
  queryFn: apiClient,
  query: loginQuery,
});

export const signup = createApi<SignupInput, AuthUserResponse>({
  queryFn: apiClient,
  query: signupQuery,
});

export const logout = createApi<void, LogoutResponse>({
  queryFn: apiClient,
  query: logoutQuery,
});
