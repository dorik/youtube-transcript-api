import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface ServerSessionUser {
  id: string;
  email: string;
}

/**
 * Server-side check used by dashboard layouts. Calls the backend's /auth/me
 * with the user's cookie. If unauthenticated, redirects to /login.
 *
 * We forward the cookie header rather than using Next's fetch cache so the
 * response always reflects the live session.
 */
export async function requireUser(): Promise<ServerSessionUser> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${BASE_URL}/auth/me`, {
    headers: { cookie: cookieHeader },
    cache: 'no-store',
  });

  if (!res.ok) {
    redirect('/login?next=/dashboard');
  }

  const data = (await res.json()) as { user: { id: string; email: string } };
  return data.user;
}
