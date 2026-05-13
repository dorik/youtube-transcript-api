'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ExternalLink, Copy, Search, Maximize2, Download, Languages } from 'lucide-react';
import { mountPlayer, type PlayerHandle } from '@/lib/youtube-player';
import type { TranscriptSegment } from '@/lib/api';
import { BLOB_URL_TTL_MS } from '@/lib/constants';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { TARGET_LANGUAGE_OPTIONS } from '@/lib/languages';
import { SubtitleOverlay } from './SubtitleOverlay';
import { SubtitleSettingsPopover } from './SubtitleSettingsPopover';
import {
  loadSubtitleSettings,
  saveSubtitleSettings,
  type SubtitleSettings,
  DEFAULT_SUBTITLE_SETTINGS,
} from '@/lib/subtitle-settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatTimecode } from '@/lib/format';
import type { TranscriptViewerProps } from './types';
import {
  findActiveSegment,
  formatDuration,
  segmentsToSubtitles,
  wordCount,
} from './utils';

/**
 * Two-pane transcript viewer: YouTube IFrame on the left, segmented
 * transcript on the right. The segment matching the current playback time
 * is highlighted; clicking a segment seeks the player.
 */
export function TranscriptViewer({
  data,
  onTranslateTargetChange,
  isRefetching,
}: TranscriptViewerProps) {
  const [theatre, setTheatre] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  // When a translation was applied, the user can flip between the
  // translated text (default) and the original-language text. The toggle
  // only appears if `data.original_segments` is present.
  const [showOriginal, setShowOriginal] = useState(false);
  const hasToggle = !!(data.translated_to && data.original_segments);
  // Subtitle overlay also needs the raw current time for word-by-word
  // highlighting. We update it on every poll tick (~4 Hz). This is the only
  // 4 Hz state in the viewer; the rest only update when the active index
  // actually changes, so re-render cost stays modest.
  const [currentTime, setCurrentTime] = useState(0);

  // Some videos can't be embedded — the owner disabled embedding (common for
  // music-label channels) or the video has been removed. The YouTube iframe
  // renders a "Video unavailable" message in that case; we swap to a clean
  // thumbnail + "Watch on YouTube" CTA instead. Reset on video change so a
  // navigation away clears the prior failure.
  const [embedError, setEmbedError] = useState<
    null | { embedDisabled: boolean; removed: boolean }
  >(null);
  useEffect(() => {
    setEmbedError(null);
  }, [data.video_id]);

  // Subtitle overlay settings, persisted to localStorage.
  const [subtitleSettings, setSubtitleSettings] = useState<SubtitleSettings>(
    DEFAULT_SUBTITLE_SETTINGS,
  );
  // Hydrate from localStorage after mount (avoids SSR/client mismatch).
  useEffect(() => {
    setSubtitleSettings(loadSubtitleSettings());
  }, []);
  function updateSubtitleSettings(next: SubtitleSettings) {
    setSubtitleSettings(next);
    saveSubtitleSettings(next);
  }

  const playerHandleRef = useRef<PlayerHandle | null>(null);
  const playerWrapperRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<Array<HTMLLIElement | null>>([]);

  // Stabilize segments. `data.segments ?? []` would create a fresh array on
  // every render, which would re-fire the player effect and rebuild the
  // iframe each time — black-box symptom.
  //
  // When the user toggles "Show original", we swap to `data.original_segments`
  // (same timestamps, untranslated text). The player effect doesn't re-run on
  // this swap because `data.video_id` is stable.
  const segments: TranscriptSegment[] = useMemo(() => {
    if (showOriginal && data.original_segments) return data.original_segments;
    return data.segments ?? [];
  }, [data.segments, data.original_segments, showOriginal]);

  const transcriptText: string = useMemo(() => {
    if (showOriginal && data.original_transcript) return data.original_transcript;
    return data.transcript;
  }, [data.transcript, data.original_transcript, showOriginal]);

  // Reset the toggle when a new video is loaded, so loading a different URL
  // doesn't carry over the previous "Show original" state silently.
  useEffect(() => {
    setShowOriginal(false);
  }, [data.video_id, data.translated_to]);

  // The polling callback closes over `segments`. Keep the latest in a ref
  // so we don't have to re-mount the player when segments change.
  const segmentsRef = useRef(segments);
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  // Mount/destroy the YouTube IFrame player when the videoId changes.
  useEffect(() => {
    const wrapper = playerWrapperRef.current;
    if (!wrapper) return;

    let cancelled = false;
    let handle: PlayerHandle | null = null;

    mountPlayer(
      wrapper,
      data.video_id,
      (t) => {
        if (cancelled) return;
        setCurrentTime(t);
        const idx = findActiveSegment(segmentsRef.current, t);
        setActiveIndex((prev) => (prev === idx ? prev : idx));
      },
      {
        onError: (e) => {
          if (cancelled) return;
          setEmbedError({embedDisabled: e.embedDisabled, removed: e.removed});
        },
      },
    )
      .then((h) => {
        if (cancelled) {
          h.destroy();
          return;
        }
        handle = h;
        playerHandleRef.current = h;
      })
      .catch((err) => {
        if (process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console -- dev-only diagnostic; the player simply doesn't render in prod
          console.error('YouTube player failed to mount', err);
        }
      });

    return () => {
      cancelled = true;
      handle?.destroy();
      playerHandleRef.current = null;
    };
  }, [data.video_id]);

  // Autoscroll: when the active segment changes and autoscroll is on,
  // bring it into view in the segment list.
  useEffect(() => {
    if (!autoscroll || activeIndex < 0) return;
    const el = segmentRefs.current[activeIndex];
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIndex, autoscroll]);

  const filteredSegments = useMemo(() => {
    if (!search.trim()) return segments.map((s, i) => ({ ...s, originalIndex: i }));
    const q = search.toLowerCase();
    return segments
      .map((s, i) => ({ ...s, originalIndex: i }))
      .filter((s) => s.text.toLowerCase().includes(q));
  }, [segments, search]);

  function onSegmentClick(seconds: number) {
    playerHandleRef.current?.seekTo(seconds);
  }

  async function copyTranscript() {
    try {
      // Copy whichever language the user is currently looking at.
      await navigator.clipboard.writeText(transcriptText);
      toast.success('Transcript copied to clipboard');
    } catch {
      toast.error('Could not access clipboard');
    }
  }

  function download(format: 'txt' | 'srt' | 'vtt' | 'json') {
    try {
      const ext = format;
      const mime =
        format === 'srt'
          ? 'application/x-subrip'
          : format === 'vtt'
            ? 'text/vtt'
            : format === 'json'
              ? 'application/json'
              : 'text/plain';
      const content =
        format === 'json'
          ? JSON.stringify(data, null, 2)
          : format === 'txt'
            ? transcriptText
            : segmentsToSubtitles(segments, format);

      if (!content || (typeof content === 'string' && !content.trim())) {
        toast.error('Nothing to export — the transcript is empty.');
        return;
      }

      const langSuffix = showOriginal ? `.${data.original_language}` : '';
      const filename = `${data.video_id}${langSuffix}.${ext}`;
      const blob = new Blob([content], { type: `${mime};charset=utf-8` });

      // Firefox + Safari require the anchor to be in the DOM before
      // .click() will start a download. Chrome doesn't, but appending is
      // harmless there. We also defer revokeObjectURL — calling it
      // synchronously can race the download on some browsers.
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);

      toast.success(`Exported ${filename}`);
    } catch {
      // The user already sees the toast; no value in a console line that
      // gets stripped in production anyway.
      toast.error('Could not start the download.');
    }
  }

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between border-b pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1 flex-wrap">
            <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
              YouTube
            </Badge>
            <span className="font-mono">{data.video_id}</span>
            {data.cached && <Badge variant="secondary">cached</Badge>}
            {data.translated_to && (
              <Badge className="bg-blue-600 hover:bg-blue-600 text-white">
                Translated {data.original_language} → {data.translated_to}
              </Badge>
            )}
          </div>
          <h1 className="text-xl font-semibold truncate">{data.title}</h1>
          <p className="text-sm text-muted-foreground">
            {data.channel} · {formatDuration(data.duration)} · {data.source.replace('_', ' ')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {hasToggle && (
            <div
              className="inline-flex items-center rounded-md border bg-muted/40 p-0.5 text-xs font-medium"
              role="group"
              aria-label="Switch between translated and original transcript"
            >
              <button
                type="button"
                onClick={() => setShowOriginal(false)}
                className={cn(
                  'px-2.5 py-1 rounded transition-colors uppercase tracking-wide',
                  !showOriginal
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {data.translated_to}
              </button>
              <button
                type="button"
                onClick={() => setShowOriginal(true)}
                className={cn(
                  'px-2.5 py-1 rounded transition-colors uppercase tracking-wide',
                  showOriginal
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {data.original_language}
              </button>
            </div>
          )}
          <SubtitleSettingsPopover
            settings={subtitleSettings}
            onChange={updateSubtitleSettings}
          />
          <Button variant="outline" size="sm" onClick={() => setTheatre((v) => !v)}>
            <Maximize2 className="h-4 w-4 mr-1.5" />
            {theatre ? 'Exit theatre' : 'Theatre Mode'}
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={data.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4 mr-1.5" />
              Open on YouTube
            </a>
          </Button>
        </div>
      </div>

      {/* Two-pane layout */}
      <div
        className={cn(
          'grid gap-6',
          theatre ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-[1.2fr_1fr]',
        )}
      >
        {/* Player. The wrapper div is React-owned (so layout/styling
            survives re-renders); the YouTube iframe is mounted as a child of
            it via `playerWrapperRef` so React never reconciles it away. The
            subtitle overlay is a sibling positioned absolutely on top — it
            doesn't capture pointer events so iframe clicks still pass
            through to YouTube's controls. */}
        <div>
          <div className="relative aspect-video bg-zinc-900 rounded-md overflow-hidden">
            {/* React-owned wrapper is always mounted (the YT SDK needs a stable
                DOM target). When the embed errors out, we layer a graceful
                fallback card on top so the user sees a clean state instead
                of YouTube's "Video unavailable" iframe message. */}
            <div ref={playerWrapperRef} className="w-full h-full" />
            {embedError && (
              <EmbedFallback
                videoId={data.video_id}
                title={data.title}
                channel={data.channel}
                reason={embedError}
              />
            )}
            {!embedError && (
              <SubtitleOverlay
                segments={segments}
                currentTime={currentTime}
                settings={subtitleSettings}
              />
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {embedError
              ? 'Inline playback isn’t available for this video, but the transcript and timestamps still work.'
              : 'Click any line on the right to jump to that timestamp. The active line highlights as the video plays.'}
          </p>
        </div>

        {/* Transcript pane */}
        <div className="border rounded-md flex flex-col max-h-[640px]">
          {/* Toolbar */}
          <div className="flex items-center gap-2 border-b px-3 py-2 bg-muted/30">
            <Button variant="default" size="sm" onClick={copyTranscript}>
              <Copy className="h-4 w-4 mr-1.5" />
              Copy
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Download className="h-4 w-4 mr-1.5" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* `onSelect` is Radix's first-class event for menu items —
                    it fires reliably across browsers, doesn't conflict with
                    the menu's close animation, and works with keyboard
                    selection. `onClick` works too, but onSelect is the
                    documented path. */}
                <DropdownMenuItem onSelect={() => download('txt')}>Export as TXT</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => download('srt')}>Export as SRT</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => download('vtt')}>Export as VTT</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => download('json')}>Export as JSON</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Search + (compact) translate-to + autoscroll. The translate
              control lives here instead of the top toolbar so it sits next
              to the transcript content it affects. */}
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search transcript"
                className="pl-7 h-8 text-sm"
              />
            </div>

            {onTranslateTargetChange && (
              <SearchableSelect
                value={data.translated_to ?? 'none'}
                onValueChange={(v) => onTranslateTargetChange(v === 'none' ? null : v)}
                disabled={isRefetching}
                // Same option list as the /new page — every language stays
                // visible regardless of the source. Translating bn→bn is a
                // benign no-op and not worth a special case.
                options={TARGET_LANGUAGE_OPTIONS.map((l) => ({
                  value: l.code,
                  label: l.label,
                }))}
                searchPlaceholder="Search languages…"
                aria-label="Translate transcript to"
                // Compact, code-style trigger ("🌐 BN") instead of the full
                // language label so it doesn't bloat the toolbar.
                className="h-7 w-auto gap-1 px-2 text-xs"
                // Popover content stays comfortably wide regardless of the
                // narrow trigger; otherwise it'd inherit the trigger's width.
                contentClassName="w-56"
                renderTriggerLabel={() => (
                  <span className="flex items-center gap-1">
                    <Languages className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="uppercase font-medium">
                      {isRefetching ? '…' : (data.translated_to ?? data.original_language)}
                    </span>
                  </span>
                )}
              />
            )}

            <div className="flex items-center gap-1.5">
              <Label htmlFor="autoscroll" className="text-xs cursor-pointer">
                Autoscroll
              </Label>
              <input
                id="autoscroll"
                type="checkbox"
                className="h-3.5 w-3.5 cursor-pointer"
                checked={autoscroll}
                onChange={(e) => setAutoscroll(e.target.checked)}
              />
            </div>
          </div>

          {/* Segments */}
          <ul className="flex-1 overflow-y-auto divide-y">
            {filteredSegments.length === 0 ? (
              <li className="p-6 text-sm text-muted-foreground text-center">
                No segments match &quot;{search}&quot;.
              </li>
            ) : (
              filteredSegments.map((seg) => {
                const i = seg.originalIndex;
                const isActive = i === activeIndex;
                return (
                  <li
                    key={i}
                    ref={(el) => {
                      segmentRefs.current[i] = el;
                    }}
                    className={cn(
                      'flex gap-3 px-3 py-2 cursor-pointer hover:bg-accent/50 transition-colors',
                      isActive && 'bg-accent border-l-2 border-l-foreground',
                    )}
                    onClick={() => onSegmentClick(seg.start)}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSegmentClick(seg.start);
                      }}
                      className="font-mono text-xs text-muted-foreground hover:text-foreground tabular-nums shrink-0 mt-0.5"
                    >
                      {formatTimecode(seg.start)}
                    </button>
                    <p className="text-sm leading-relaxed">{seg.text}</p>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </div>

      {/* Footer info */}
      <div className="border-t pt-3 flex items-center gap-4 text-xs text-muted-foreground">
        <span>{segments.length} segments</span>
        <span>{wordCount(transcriptText).toLocaleString()} words</span>
        <span>Credits used: {data.credits_used}</span>
        <span>Credits remaining: {data.credits_remaining}</span>
        <span className="ml-auto">
          <Link href="/dashboard/transcripts/new" className="hover:text-foreground underline">
            Load another video
          </Link>
        </span>
      </div>
    </div>
  );
}

/**
 * Fallback card rendered on top of the (silent) YouTube iframe when embed
 * playback isn't possible — typically the channel owner has disabled
 * embedding (codes 101/150) or the video was removed (100). The transcript
 * pane is unaffected; this only swaps the player tile for a static thumbnail
 * + "Watch on YouTube" CTA so the user has somewhere to go.
 */
function EmbedFallback({
  videoId,
  title,
  channel,
  reason,
}: {
  videoId: string;
  title: string;
  channel: string;
  reason: { embedDisabled: boolean; removed: boolean };
}) {
  // YouTube's hqdefault thumbnail is the most reliable size: present for
  // every uploaded video (including age-gated and embed-disabled ones).
  const thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const message = reason.removed
    ? 'This video has been removed or made private on YouTube.'
    : reason.embedDisabled
      ? 'The video owner has disabled inline playback.'
      : 'This video can’t be played inline.';

  return (
    <div className="absolute inset-0 flex flex-col bg-zinc-900 text-zinc-100">
      <div className="relative flex-1 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- external thumb, no Next/Image optimization wanted here */}
        <img
          src={thumb}
          alt={title}
          className="h-full w-full object-cover opacity-60"
        />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="max-w-sm text-sm font-medium">{message}</p>
          <Button asChild size="sm" variant="secondary">
            <a href={watchUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1.5 h-4 w-4" />
              Watch on YouTube
            </a>
          </Button>
        </div>
      </div>
      <div className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        <span className="font-medium text-zinc-200">{title}</span>
        <span className="ml-2">· {channel}</span>
      </div>
    </div>
  );
}
