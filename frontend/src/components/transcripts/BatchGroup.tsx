'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { TranscriptRequestRow } from './TranscriptRequestRow';
import { useTranscriptBatchQuery } from '@/features/transcripts';
import type { TranscriptBatch } from '@/lib/api';

interface Props {
  batch: TranscriptBatch;
  /** Cancel handler passed through to each queued child row. */
  onCancel?: (id: string) => void;
  canceling?: boolean;
}

/**
 * A collapsible group for one bulk batch. The header shows the playlist /
 * channel label and derived progress; expanding fetches and lists the
 * batch's child requests.
 */
export function BatchGroup({ batch, onCancel, canceling }: Props) {
  const [open, setOpen] = useState(false);
  const batchQuery = useTranscriptBatchQuery(batch.id, open);
  const progress = batchQuery.data?.progress;

  const summary = progress
    ? `${progress.completed}/${batch.total} done` +
      (progress.failed ? ` · ${progress.failed} failed` : '')
    : `${batch.total} videos`;

  return (
    <Card>
      <CardContent className="p-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2 p-3 sm:p-4 text-left hover:bg-muted/40"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate">
              {batch.kind === 'playlist'
                ? 'Playlist'
                : batch.kind === 'channel'
                  ? 'Channel'
                  : 'Video list'}
              {batch.label ? `: ${batch.label}` : ''}
            </p>
            <p className="text-xs text-muted-foreground">{summary}</p>
          </div>
        </button>

        {open && (
          <div className="border-t p-3 sm:p-4 space-y-2">
            {batchQuery.isLoading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {batchQuery.data?.requests.map((r) => (
              <TranscriptRequestRow
                key={r.id}
                request={r}
                onCancel={onCancel}
                canceling={canceling}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
