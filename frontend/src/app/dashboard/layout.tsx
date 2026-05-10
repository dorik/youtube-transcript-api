'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { DashboardSidebar } from '@/components/dashboard/sidebar';
import { DashboardTopbar } from '@/components/dashboard/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { auth, type User } from '@/lib/api';

/**
 * Client-side auth guard for the dashboard.
 *
 * Why not server-side? The session cookie is set by the backend on
 * `<api>.onrender.com`. In a production deploy where the frontend lives on
 * `vercel.app`, the browser only sends that cookie to the backend's origin.
 * A server-rendered Next.js layout running on Vercel can't see it. So
 * `await requireUser()` from a server component would bounce every signed-in
 * user back to /login.
 *
 * Doing the check from the client side via fetch+credentials makes the
 * browser include the cross-domain cookie automatically (works because the
 * backend sets `SameSite=None; Secure` cookies in production).
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // We snapshot pathname once on mount so the auth check only runs at
  // initial dashboard entry — not on every sidebar click. The router
  // replace below uses this snapshot for the ?next= param.
  const initialPath = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<'loading' | 'authed' | 'unauthed'>('loading');

  useEffect(() => {
    let cancelled = false;
    auth
      .me()
      .then(({ user }) => {
        if (cancelled) return;
        setUser(user);
        setStatus('authed');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('unauthed');
        // Use replace so back-button doesn't loop the user back into the
        // protected page they were trying to reach.
        const next = initialPath || '/dashboard';
        router.replace(`/login?next=${encodeURIComponent(next)}`);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrap-only effect; re-running on initialPath/router changes would spin the skeleton on every dashboard navigation
  }, []);

  if (status === 'loading') {
    return <DashboardLoadingSkeleton />;
  }
  if (status === 'unauthed' || !user) {
    // Render nothing while the redirect is in flight; avoids a flash of
    // dashboard chrome before the router push lands.
    return null;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <DashboardTopbar userEmail={user.email} />
      <div className="flex flex-1">
        <DashboardSidebar />
        <main className="flex-1 p-6 md:p-8">{children}</main>
      </div>
    </div>
  );
}

function DashboardLoadingSkeleton() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="flex h-14 items-center justify-between px-4 md:px-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-6 w-24" />
        </div>
      </header>
      <div className="flex flex-1">
        <aside className="w-56 border-r bg-muted/30 hidden md:block p-4 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </aside>
        <main className="flex-1 p-6 md:p-8 space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32" />
        </main>
      </div>
    </div>
  );
}
