import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="border-t mt-16">
      <div className="container mx-auto flex flex-col items-center justify-between gap-2 px-4 py-6 max-w-6xl text-sm text-muted-foreground sm:flex-row">
        <p>© {new Date().getFullYear()} YouTube Transcripts API. All rights reserved.</p>
        <nav className="flex items-center gap-4">
          <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
          <Link href="/docs" className="hover:text-foreground">Docs</Link>
        </nav>
      </div>
    </footer>
  );
}
