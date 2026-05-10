import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getCurrentUser,
  login,
  logout,
  signup,
} from './auth.service';
import type {
  AuthUserResponse,
  LoginInput,
  LogoutResponse,
  SignupInput,
} from './types';
import { authQueryKeys } from './queryKeys';

export function useCurrentUserQuery() {
  return useQuery<AuthUserResponse, Error>({
    queryKey: authQueryKeys.me(),
    queryFn: () => getCurrentUser(),
    retry: false,
    meta: { suppressGlobalError: true },
  });
}

export function useLoginMutation() {
  const queryClient = useQueryClient();

  return useMutation<AuthUserResponse, Error, LoginInput>({
    mutationFn: login,
    meta: { suppressGlobalError: true },
    onSuccess: (data) => {
      queryClient.setQueryData(authQueryKeys.me(), data);
    },
  });
}

export function useSignupMutation() {
  const queryClient = useQueryClient();

  return useMutation<AuthUserResponse, Error, SignupInput>({
    mutationFn: signup,
    meta: { suppressGlobalError: true },
    onSuccess: (data) => {
      queryClient.setQueryData(authQueryKeys.me(), data);
    },
  });
}

export function useLogoutMutation() {
  const queryClient = useQueryClient();

  return useMutation<LogoutResponse, Error, void>({
    mutationFn: logout,
    meta: { suppressGlobalError: true },
    onSettled: () => {
      queryClient.removeQueries({ queryKey: authQueryKeys.all });
    },
  });
}
