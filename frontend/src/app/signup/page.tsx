'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { auth, billing } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/apiError';
import { SiteNav } from '@/components/marketing/site-nav';

// Suspense wrapper required for `useSearchParams()` during static render.
// See login/page.tsx for the same pattern.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageImpl />
    </Suspense>
  );
}

function SignupPageImpl() {
  const router = useRouter();
  const params = useSearchParams();
  const planParam = params.get('plan'); // optional ?plan=pro

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await auth.signup({ email, password });
      toast.success('Welcome! Account created.');

      // If they came from a pricing CTA, kick them to checkout
      if (planParam === 'starter' || planParam === 'pro' || planParam === 'business') {
        try {
          const { url } = await billing.checkout(planParam);
          // Full-document redirect — Stripe checkout is a third-party origin;
          // router.push won't navigate cross-origin.
          window.location.href = url;
          return;
        } catch {
          toast.error('Could not start checkout — taking you to the dashboard.');
          // fall through to dashboard
        }
      }
      router.push('/dashboard');
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Signup failed'));
      setSubmitting(false);
    }
  }

  return (
    <>
      <SiteNav />
      <main className="container mx-auto max-w-md px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Create your account</CardTitle>
            <p className="text-sm text-muted-foreground">
              100 free credits, no card required.
              {planParam && (
                <>
                  {' '}You&apos;ll be sent to checkout for the <strong>{planParam}</strong> plan after signup.
                </>
              )}
            </p>
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
                  autoComplete="new-password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">At least 8 characters.</p>
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? 'Creating account…' : 'Create account'}
              </Button>
            </form>
            <p className="mt-6 text-sm text-center text-muted-foreground">
              Already have an account?{' '}
              <Link href="/login" className="font-medium text-foreground hover:underline">
                Log in
              </Link>
            </p>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
