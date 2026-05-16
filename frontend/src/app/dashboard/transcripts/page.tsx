'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DEFAULT_PAGE_SIZE } from '@/lib/constants';
import { getApiErrorMessage } from '@/lib/apiError';
import { TranscriptRequestRow } from '@/components/transcripts/TranscriptRequestRow';
import { BatchGroup } from '@/components/transcripts/BatchGroup';
import {
  useCancelTranscriptMutation,
  useTranscriptRequestsQuery,
} from '@/features/transcripts';
import type { TranscriptBatch, TranscriptRequest } from '@/lib/api';

const PAGE_SIZE = DEFAULT_PAGE_SIZE;

/**
 * Unified transcripts list — standalone request rows plus collapsible batch
 * groups, newest first. React Query polls while any row is queued/processing
 * so statuses advance without a manual refresh; the Refresh button forces an
 * immediate re-fetch.
 */
export default function TranscriptsPage() {
  const [offset, setOffset] = useState(0);

  const listQuery = useTranscriptRequestsQuery({ limit: PAGE_SIZE, offset });
  const cancelMutation = useCancelTranscriptMutation();

  const items = useMemo(
    () => listQuery.data?.items ?? [],
    [listQuery.data?.items],
  );
  const total = listQuery.data?.total ?? 0;
  const loading = listQuery.isLoading;

  // Build the display order: each standalone request is its own entry; the
  // rows of a batch collapse into a single batch entry positioned at the
  // batch's newest row.
  const entries = useMemo(() => {
    const result: Array<
      | { kind: 'request'; request: TranscriptRequest }
      | { kind: 'batch'; batch: TranscriptBatch }
    > = [];
    const seenBatches = new Set<string>();
    for (const r of items) {
      if (!r.batch_id) {
        result.push({ kind: 'request', request: r });
        continue;
      }
      if (seenBatches.has(r.batch_id)) continue;
      seenBatches.add(r.batch_id);
      // The batch row carries enough to render the header; BatchGroup
      // fetches full detail (label, progress) on expand.
      result.push({
        kind: 'batch',
        batch: {
          id: r.batch_id,
          kind: 'videos',
          source_url: null,
          label: null,
          total: 0,
          created_at: r.created_at,
        },
      });
    }
    return result;
  }, [items]);

  function handleCancel(id: string) {
    cancelMutation.mutate(id, {
      onSuccess: () => toast.success('Request canceled'),
      onError: (err) =>
        toast.error(getApiErrorMessage(err, 'Could not cancel request')),
    });
  }

  const hasResults = entries.length > 0;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Transcripts</h1>
          <p className="text-muted-foreground text-sm">
            Every transcript you&apos;ve requested. New requests run in the
            background — you can queue more right away.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void listQuery.refetch()}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
          <Button asChild>
            <Link href="/dashboard/transcripts/new">
              <Plus className="h-4 w-4 mr-1.5" />
              New transcript
            </Link>
          </Button>
        </div>
      </div>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}

      {!loading && !hasResults && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No transcripts yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Request your first transcript from a YouTube URL — it&apos;ll
              appear here and process in the background.
            </p>
            <Button asChild>
              <Link href="/dashboard/transcripts/new">
                <Plus className="h-4 w-4 mr-1.5" />
                New transcript
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {hasResults && (
        <div className="space-y-2">
          {entries.map((entry) =>
            entry.kind === 'request' ? (
              <TranscriptRequestRow
                key={entry.request.id}
                request={entry.request}
                onCancel={handleCancel}
                canceling={cancelMutation.isPending}
              />
            ) : (
              <BatchGroup
                key={entry.batch.id}
                batch={entry.batch}
                onCancel={handleCancel}
                canceling={cancelMutation.isPending}
              />
            ),
          )}
        </div>
      )}

      {hasResults && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm pt-2">
          <span className="text-muted-foreground">
            Showing {offset + 1}–{Math.min(offset + items.length, total)} of{' '}
            {total}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
