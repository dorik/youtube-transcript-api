'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/transcripts', label: 'Transcripts' },
  { href: '/dashboard/api-keys', label: 'API Keys' },
  { href: '/dashboard/usage', label: 'Usage' },
  { href: '/dashboard/playground', label: 'Playground' },
  { href: '/dashboard/billing', label: 'Billing' },
];

export function DashboardSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 border-r bg-muted/30 hidden md:block">
      <nav className="flex flex-col gap-1 p-4 text-sm">
        {ITEMS.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== '/dashboard' && pathname?.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-md px-3 py-2 transition-colors',
                active
                  ? 'bg-foreground text-background font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {item.label}
            </Link>
          );
        })}
        <div className="border-t my-3" />
        <Link
          href="/docs"
          className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-foreground flex items-center justify-between"
        >
          Docs
          <span aria-hidden>↗</span>
        </Link>
      </nav>
    </aside>
  );
}
