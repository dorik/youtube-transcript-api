'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import Link from 'next/link';
import debounce from 'lodash/debounce';
import { Plus, Search, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { SEARCH_DEBOUNCE_MS, DEFAULT_PAGE_SIZE } from '@/lib/constants';
import { HistoryRow } from '@/components/transcripts-history/HistoryRow';
import { useTranscriptsQuery } from '@/features/transcripts';

const PAGE_SIZE = DEFAULT_PAGE_SIZE;

/**
 * Transcript history. One row per video the user has fetched, sorted by
 * most recent. Searchable by title / channel / video id. Clicking a row
 * routes to the path-based viewer at /dashboard/transcripts/[videoId].
 */
export default function TranscriptsHistoryPage() {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const updateQuery = useMemo(
    () => debounce((next: string) => setQuery(next.trim()), SEARCH_DEBOUNCE_MS),
    [],
  );
  const handleSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setSearch(next);
      updateQuery(next);
    },
    [updateQuery],
  );
  const transcriptsQuery = useTranscriptsQuery({
    limit: PAGE_SIZE,
    offset,
    q: query || undefined,
  });

  const items = transcriptsQuery.data?.items ?? [];
  const total = transcriptsQuery.data?.total ?? 0;
  const loading = transcriptsQuery.isLoading;

  useEffect(() => () => updateQuery.cancel(), [updateQuery]);

  // Reset pagination whenever the active query changes.
  useEffect(() => {
    setOffset(0);
  }, [query]);

  function refresh() {
    void transcriptsQuery.refetch();
  }

  const hasResults = items.length > 0;
  const hasNoResults = items.length === 0 && !loading;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Transcripts</h1>
          <p className="text-muted-foreground text-sm">
            Every video you&apos;ve fetched. Click any item to re-open the viewer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
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

      {/* Search bar */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by title, channel, or video id…"
          value={search}
          onChange={handleSearchChange}
          className="pl-9"
        />
      </div>

      {/* List */}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}

      {hasNoResults && (
        <EmptyState query={query} />
      )}

      {hasResults && (
        <div className="space-y-2">
          {items.map((item) => (
            <HistoryRow key={item.video_id} item={item} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {hasResults && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm pt-2">
          <span className="text-muted-foreground">
            Showing {offset + 1}–{Math.min(offset + items.length, total)} of {total}
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

function EmptyState({ query }: { query: string }) {
  if (query) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No matches</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Nothing in your history matches &quot;{query}&quot;.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">No transcripts yet</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Fetch your first transcript from a YouTube URL — it&apos;ll show up here for
          quick access later.
        </p>
        <Button asChild>
          <Link href="/dashboard/transcripts/new">
            <Plus className="h-4 w-4 mr-1.5" />
            New transcript
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
