'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getApiErrorMessage } from '@/lib/apiError';
import { SiteNav } from '@/components/marketing/site-nav';
import { useLoginMutation } from '@/features/auth';

// Next.js requires components calling `useSearchParams()` to be wrapped in
// a Suspense boundary, otherwise the build refuses to prerender the page.
// Splitting the default export into a thin Suspense shell + the real
// component is the canonical fix.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageImpl />
    </Suspense>
  );
}

function LoginPageImpl() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const loginMutation = useLoginMutation();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loginMutation.isPending) return;

    loginMutation.mutate(
      { email, password },
      {
        onSuccess: () => router.push(next),
        onError: (err) => toast.error(getApiErrorMessage(err, 'Login failed')),
      },
    );
  }

  return (
    <>
      <SiteNav />
      <main className="container mx-auto max-w-md px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Welcome back</CardTitle>
            <p className="text-sm text-muted-foreground">Log in to your account.</p>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={loginMutation.isPending}>
                {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
            <p className="mt-6 text-sm text-center text-muted-foreground">
              Don&apos;t have an account?{' '}
              <Link href="/signup" className="font-medium text-foreground hover:underline">
                Sign up
              </Link>
            </p>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
