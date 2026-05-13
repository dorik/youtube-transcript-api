import { memo } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { HistoryItem } from '@/lib/api';
import { formatRelativeTime, formatTimecode } from '@/lib/format';

/**
 * One row in the transcripts history list. Memoized so re-renders of the
 * parent (e.g. when search input changes) don't ripple through every row.
 */
export const HistoryRow = memo(function HistoryRow({ item }: { item: HistoryItem }) {
  return (
    <Link href={`/dashboard/transcripts/${item.video_id}`} className="block group">
      <Card className="transition-colors group-hover:border-foreground/30">
        <CardContent className="p-3 sm:p-4 flex gap-4 items-start">
          {/* Thumbnail. Falling back to a placeholder div if YouTube ever
              429s the thumbnail CDN — using next/image with unoptimized so
              we don't need to whitelist YT in next.config. */}
          <div className="relative shrink-0 w-32 sm:w-40 aspect-video bg-muted rounded overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element -- YouTube thumbnail CDN doesn't need next/image optimization, and using <Image> here would force adding YT to remotePatterns */}
            <img
              src={item.thumbnail_url}
              alt=""
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover"
            />
            {item.duration_seconds ? (
              <span className="absolute bottom-1 right-1 rounded bg-black/80 text-white text-[10px] font-medium px-1 py-0.5 tabular-nums">
                {formatTimecode(item.duration_seconds)}
              </span>
            ) : null}
          </div>

          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-semibold text-sm line-clamp-2 group-hover:underline">
                {item.title ?? <span className="text-muted-foreground">Untitled</span>}
              </h3>
              <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                {formatRelativeTime(item.last_fetched_at)}
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
                  {item.last_source === 'whisper' ? 'OpenAI' : 'native'}
                </Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
});
