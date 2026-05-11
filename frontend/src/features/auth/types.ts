import type { User } from '@/lib/api';

export interface AuthUserResponse {
  user: User;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface SignupInput {
  email: string;
  password: string;
  display_name?: string;
}

export interface LogoutResponse {
  ok: true;
}
