"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Dashboard-scope error boundary. Catches uncaught errors thrown during
 * render of any `/dashboard/**` route without nuking the marketing site.
 *
 * Per-route `error.tsx` files (e.g. `dashboard/transcripts/[videoId]/error.tsx`)
 * can override this for higher-risk pages.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console -- dev-only diagnostic
      console.error("Dashboard error", error);
    }
  }, [error]);

  return (
    <div className="p-6 max-w-md">
      <h2 className="text-lg font-semibold mb-2">Could not load this page</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {error.message || "Something unexpected happened. Try again, or go back."}
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <a href="/dashboard">Back to dashboard</a>
        </Button>
      </div>
    </div>
  );
}
