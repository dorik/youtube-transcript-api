import Link from 'next/link';
import { Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

  // Build the text the Copy button should hand to the clipboard. JSON
  // format renders as a segment table in the UI (not raw JSON) — so for
  // that case copy the full envelope a developer would consume. For
  // text / SRT / VTT / text-timestamps the rendered body IS the
  // transcript field, so copy that verbatim.
  const copyTextForActive =
    active?.ok && active.data
      ? active.data.format === 'json'
        ? JSON.stringify(active.data, null, 2)
        : active.data.transcript
      : null;

  async function handleCopyResponse() {
    if (!copyTextForActive) return;
    try {
      await navigator.clipboard.writeText(copyTextForActive);
      toast.success('Response copied to clipboard');
    } catch {
      toast.error('Could not access clipboard');
    }
  }

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
            </Badge>
          )}
          {copyTextForActive && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCopyResponse}
              aria-label="Copy response to clipboard"
              className="ml-auto h-7 gap-1 px-2 text-xs font-medium"
            >
              <Copy className="h-3 w-3" />
              Copy response
            </Button>
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
            // Bulk runs (playlist/channel) end up with N results in the tab
            // strip; opening one in the viewer with a same-tab nav drops the
            // other N-1 from the screen. Open in a new tab when there's more
            // than one result so the playground stays available.
            const openInNewTab = (results?.length ?? 0) > 1;
            return (
              <Link
                href={href}
                {...(openInNewTab
                  ? {target: '_blank', rel: 'noreferrer'}
                  : {})}
                className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
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
