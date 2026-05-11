import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { extractVideoId } from '@/lib/youtube-url';
import type { BulkResultEntry } from './types';
import { shortVideoId } from './utils';
import { RenderedResult } from './RenderedResult';

/**
 * Right-side response panel: tabs (one per bulk URL), source/translation
 * badges, "Open in viewer" deep-link, and the rendered result body.
 */
export function ResultsCard({
  results,
  submitting,
  activeIdx,
  onSelect,
  showTimestamps,
  language,
  translateTo,
}: {
  results: BulkResultEntry[] | null;
  submitting: boolean;
  activeIdx: number;
  onSelect: (i: number) => void;
  showTimestamps: boolean;
  language: string;
  translateTo: string;
}) {
  if (results === null && !submitting) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Response</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Fill in the form on the left and hit Fetch.
          </p>
        </CardContent>
      </Card>
    );
  }

  const active = results?.[activeIdx];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          Response
          {active?.ok && active.data?.cached && <Badge variant="secondary">cached</Badge>}
          {active?.ok && active.data && (
            <Badge variant="outline">{active.data.source}</Badge>
          )}
          {active?.ok && active.data?.translated_to && (
            <Badge variant="default" className="bg-blue-600 hover:bg-blue-600">
              {active.data.original_language} → {active.data.translated_to}
              {active.data.translation_stubbed ? ' (stub)' : ''}
            </Badge>
          )}
          {active?.ok && active.data && (() => {
            // Dashboard viewer is path-based: /dashboard/transcripts/[videoId].
            // Prefer the canonical video_id from the response (handles
            // shortened youtu.be / embed / live URLs); fall back to
            // parsing the request URL on the rare chance the response
            // doesn't include it.
            const videoId = active.data.video_id ?? extractVideoId(active.url);
            if (!videoId) return null;
            const qs = new URLSearchParams();
            if (language !== 'auto') qs.set('language', language);
            if (translateTo !== 'none') qs.set('translate_to', translateTo);
            const search = qs.toString();
            const href = `/dashboard/transcripts/${videoId}${search ? `?${search}` : ''}`;
            return (
              <Link
                href={href}
                className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
              >
                Open in viewer
                <ExternalLink className="h-3 w-3" />
              </Link>
            );
          })()}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Result tabs (one per submitted URL) */}
        {results && results.length > 1 && (
          <div className="flex items-center gap-1 mb-3 overflow-x-auto pb-1">
            {results.map((r, i) => (
              <button
                key={`${r.url}-${i}`}
                type="button"
                onClick={() => onSelect(i)}
                className={`text-xs px-2.5 py-1 rounded-md whitespace-nowrap transition-colors ${
                  i === activeIdx
                    ? 'bg-foreground text-background'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {r.ok ? '✓' : '✗'} {shortVideoId(r.url)}
              </button>
            ))}
          </div>
        )}

        {submitting && !active ? (
          <Skeleton className="h-72" />
        ) : !active ? (
          <Skeleton className="h-72" />
        ) : !active.ok ? (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            <p className="font-medium mb-1">Failed: {shortVideoId(active.url)}</p>
            <p>{active.error}</p>
          </div>
        ) : active.data ? (
          <RenderedResult data={active.data} showTimestamps={showTimestamps} />
        ) : null}
      </CardContent>
    </Card>
  );
}
