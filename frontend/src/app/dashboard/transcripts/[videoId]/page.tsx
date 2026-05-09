'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ApiError, transcripts as transcriptsApi, TranscriptResponse } from '@/lib/api';
import { TranscriptViewer } from '@/components/dashboard/transcript-viewer';
import { buildWatchUrl } from '@/lib/youtube-url';

/**
 * Path-based viewer. Video id comes from `[videoId]`; optional `language`
 * and `translate_to` are read from query params so the URL stays
 * shareable / bookmarkable.
 */
export default function TranscriptViewPage() {
  const router = useRouter();
  const params = useParams<{ videoId: string }>();
  const search = useSearchParams();

  const videoId = params.videoId;
  const langParam = search.get('language') ?? '';
  const translateParam = search.get('translate_to') ?? '';

  const [data, setData] = useState<TranscriptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Re-fetch whenever the videoId or relevant query params change. We
  // don't null out `data` between fetches so an in-viewer translate change
  // keeps the viewer mounted (with an inline "translating…" spinner).
  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    transcriptsApi
      .fetchAsUser({
        url: buildWatchUrl(videoId),
        language: langParam || undefined,
        translate_to: translateParam || undefined,
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMsg(err instanceof ApiError ? err.message : 'Could not load transcript');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [videoId, langParam, translateParam]);

  function onTranslateTargetChange(target: string | null) {
    if (!videoId) return;
    const next = new URLSearchParams();
    if (langParam) next.set('language', langParam);
    if (target) next.set('translate_to', target);
    const qs = next.toString();
    router.push(`/dashboard/transcripts/${videoId}${qs ? `?${qs}` : ''}`);
  }

  // Inline spinner state — for re-fetches after the viewer is already up.
  const isRefetching = loading && data !== null;

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/transcripts">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to history
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/transcripts/new">New transcript</Link>
        </Button>
      </div>

      {loading && !data && (
        <Card>
          <CardContent className="p-6">
            <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6">
              <Skeleton className="aspect-video" />
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {errorMsg && !loading && !data && (
        <Card>
          <CardContent className="p-6">
            <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              <p className="font-medium mb-1">Could not load transcript</p>
              <p>{errorMsg}</p>
            </div>
            <Button asChild variant="outline" className="mt-4">
              <Link href="/dashboard/transcripts/new">Try another URL</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {data && (
        <TranscriptViewer
          data={data}
          onTranslateTargetChange={onTranslateTargetChange}
          isRefetching={isRefetching}
        />
      )}
    </div>
  );
}
