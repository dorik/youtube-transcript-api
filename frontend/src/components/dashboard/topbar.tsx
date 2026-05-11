'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useLogoutMutation } from '@/features/auth';

export function DashboardTopbar({ userEmail }: { userEmail: string }) {
  const router = useRouter();
  const logoutMutation = useLogoutMutation();

  function handleLogout() {
    logoutMutation.mutate(undefined, {
      onSettled: () => {
        toast.success('Signed out');
        router.push('/login');
      },
    });
  }

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="flex h-14 items-center justify-between px-4 md:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="inline-block h-6 w-6 rounded bg-foreground" aria-hidden />
          <span className="hidden sm:inline">YouTube Transcripts API</span>
        </Link>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-sm text-muted-foreground">{userEmail}</span>
          <Button variant="outline" size="sm" onClick={handleLogout} disabled={logoutMutation.isPending}>
            Log out
          </Button>
        </div>
      </div>
    </header>
  );
}
