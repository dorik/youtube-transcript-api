'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Search, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  ApiError,
  transcripts as transcriptsApi,
  type HistoryItem,
} from '@/lib/api';

const PAGE_SIZE = 25;

/**
 * Transcript history. One row per video the user has fetched, sorted by
 * most recent. Searchable by title / channel / video id. Clicking a row
 * routes to the path-based viewer at /dashboard/transcripts/[videoId].
 */
export default function TranscriptsHistoryPage() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // Debounce the search box so we don't hammer the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Reset pagination whenever the active query changes.
  useEffect(() => {
    setOffset(0);
  }, [debouncedSearch]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    transcriptsApi
      .listMine({
        limit: PAGE_SIZE,
        offset,
        q: debouncedSearch || undefined,
      })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        toast.error(err instanceof ApiError ? err.message : 'Could not load history');
        setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [offset, debouncedSearch]);

  function refresh() {
    setLoading(true);
    transcriptsApi
      .listMine({ limit: PAGE_SIZE, offset, q: debouncedSearch || undefined })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        toast.error(err instanceof ApiError ? err.message : 'Could not refresh');
      })
      .finally(() => setLoading(false));
  }

  const hasResults = items !== null && items.length > 0;
  const hasNoResults = items !== null && items.length === 0 && !loading;

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
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* List */}
      {loading && items === null && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}

      {hasNoResults && (
        <EmptyState query={debouncedSearch} />
      )}

      {hasResults && (
        <div className="space-y-2">
          {items!.map((item) => (
            <HistoryRow key={item.video_id} item={item} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {hasResults && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm pt-2">
          <span className="text-muted-foreground">
            Showing {offset + 1}–{Math.min(offset + items!.length, total)} of {total}
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

function HistoryRow({ item }: { item: HistoryItem }) {
  return (
    <Link
      href={`/dashboard/transcripts/${item.video_id}`}
      className="block group"
    >
      <Card className="transition-colors group-hover:border-foreground/30">
        <CardContent className="p-3 sm:p-4 flex gap-4 items-start">
          {/* Thumbnail. Falling back to a placeholder div if YouTube ever
              429s the thumbnail CDN — using next/image with unoptimized so
              we don't need to whitelist YT in next.config. */}
          <div className="relative shrink-0 w-32 sm:w-40 aspect-video bg-muted rounded overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.thumbnail_url}
              alt=""
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover"
            />
            {item.duration_seconds ? (
              <span className="absolute bottom-1 right-1 rounded bg-black/80 text-white text-[10px] font-medium px-1 py-0.5 tabular-nums">
                {formatDuration(item.duration_seconds)}
              </span>
            ) : null}
          </div>

          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-semibold text-sm line-clamp-2 group-hover:underline">
                {item.title ?? <span className="text-muted-foreground">Untitled</span>}
              </h3>
              <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                {formatRelative(item.last_fetched_at)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {item.channel ?? '—'} · <span className="font-mono">{item.video_id}</span>
            </p>
            <div className="flex items-center gap-1.5 flex-wrap pt-1">
              {item.language && (
                <Badge variant="outline" className="font-mono text-[10px] uppercase">
                  {item.language}
                </Badge>
              )}
              {item.last_source && (
                <Badge variant="secondary" className="text-[10px]">
                  {item.last_source === 'whisper' ? 'whisper' : 'native'}
                </Badge>
              )}
              {item.last_cache_hit ? (
                <Badge variant="secondary" className="text-[10px]">cached</Badge>
              ) : null}
              {item.fetch_count > 1 && (
                <Badge variant="outline" className="text-[10px]">
                  {item.fetch_count}× fetched
                </Badge>
              )}
              {item.last_credits_used != null && item.last_credits_used > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  {item.last_credits_used} credits
                </Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
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

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
