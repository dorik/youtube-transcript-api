'use client';

import { memo } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RequestStatusBadge } from './RequestStatusBadge';
import { formatRelativeTime, formatTimecode } from '@/lib/format';
import type { TranscriptRequest } from '@/lib/api';

interface Props {
  request: TranscriptRequest;
  /** Cancel handler — only rendered for `queued` rows. */
  onCancel?: (id: string) => void;
  canceling?: boolean;
}

/**
 * One row in the unified transcripts list. A `completed` row links into the
 * viewer; non-completed rows show their status and (for `queued`) a cancel
 * action. Metadata renders as soon as the worker fills it in.
 */
export const TranscriptRequestRow = memo(function TranscriptRequestRow({
  request,
  onCancel,
  canceling,
}: Props) {
  const clickable = request.status === 'completed';
  const inner = (
    <Card
      className={
        clickable ? 'transition-colors group-hover:border-foreground/30' : ''
      }
    >
      <CardContent className="p-3 sm:p-4 flex gap-4 items-start">
        <div className="relative shrink-0 w-32 sm:w-40 aspect-video bg-muted rounded overflow-hidden">
          {request.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- YouTube thumbnail CDN; <Image> would force remotePatterns config
            <img
              src={request.thumbnail_url}
              alt=""
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-[10px] text-muted-foreground">
              No preview
            </div>
          )}
          {request.duration_seconds ? (
            <span className="absolute bottom-1 right-1 rounded bg-black/80 text-white text-[10px] font-medium px-1 py-0.5 tabular-nums">
              {formatTimecode(request.duration_seconds)}
            </span>
          ) : null}
        </div>

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-semibold text-sm line-clamp-2">
              {request.title ?? (
                <span className="text-muted-foreground">
                  {request.request.url}
                </span>
              )}
            </h3>
            <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
              {formatRelativeTime(request.created_at)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {request.channel ?? '—'}
            {request.video_id ? (
              <>
                {' · '}
                <span className="font-mono">{request.video_id}</span>
              </>
            ) : null}
          </p>
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            <RequestStatusBadge status={request.status} />
            {request.status === 'failed' && request.error_message && (
              <span className="text-[11px] text-destructive line-clamp-1">
                {request.error_message}
              </span>
            )}
            {request.status === 'processing' && (
              <span className="text-[11px] text-muted-foreground">
                Transcribing…
              </span>
            )}
            {request.status === 'queued' && (
              <span className="text-[11px] text-muted-foreground">
                Waiting in queue
              </span>
            )}
          </div>
        </div>

        {request.status === 'queued' && onCancel && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={canceling}
            onClick={(e) => {
              e.preventDefault();
              onCancel(request.id);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </CardContent>
    </Card>
  );

  if (clickable) {
    return (
      <Link
        href={`/dashboard/transcripts/${request.id}`}
        className="block group"
      >
        {inner}
      </Link>
    );
  }
  return <div>{inner}</div>;
});
