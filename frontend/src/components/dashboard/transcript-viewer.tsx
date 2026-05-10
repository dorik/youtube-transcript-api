'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ExternalLink, Copy, Search, Maximize2, Download, Languages } from 'lucide-react';
import { mountPlayer, type PlayerHandle } from '@/lib/youtube-player';
import type { TranscriptResponse, TranscriptSegment } from '@/lib/api';
import { BLOB_URL_TTL_MS } from '@/lib/constants';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { TARGET_LANGUAGE_OPTIONS } from '@/lib/languages';
import { SubtitleOverlay } from '@/components/dashboard/subtitle-overlay';
import { SubtitleSettingsPopover } from '@/components/dashboard/subtitle-settings-popover';
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

interface Props {
  data: TranscriptResponse;
  /** Called when the user picks a different language (refetch). */
  onLanguageChange?: (lang: string) => void;
  /**
   * Called when the user picks a translation target from inside the viewer.
   * `target` is an ISO 639-1 code or `null` to remove translation.
   * The page should re-fetch with the new param and pass fresh `data` back.
   */
  onTranslateTargetChange?: (target: string | null) => void;
  /** True while the page is re-fetching (e.g. after a translate change). */
  isRefetching?: boolean;
}

/**
 * Two-pane transcript viewer: YouTube IFrame on the left, segmented
 * transcript on the right. The segment matching the current playback time
 * is highlighted; clicking a segment seeks the player.
 */
export function TranscriptViewer({
  data,
  onTranslateTargetChange,
  isRefetching,
}: Props) {
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

    mountPlayer(wrapper, data.video_id, (t) => {
      if (cancelled) return;
      setCurrentTime(t);
      const idx = findActiveSegment(segmentsRef.current, t);
      setActiveIndex((prev) => (prev === idx ? prev : idx));
    })
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
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1 flex-wrap">
            <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
              YouTube
            </Badge>
            <span className="font-mono">{data.video_id}</span>
            {data.cached && <Badge variant="secondary">cached</Badge>}
            {data.translated_to && (
              <Badge className="bg-blue-600 hover:bg-blue-600 text-white">
                Translated {data.original_language} → {data.translated_to}
                {data.translation_stubbed ? ' (stub)' : ''}
              </Badge>
            )}
          </div>
          <h1 className="text-xl font-semibold truncate">{data.title}</h1>
          <p className="text-sm text-muted-foreground">
            {data.channel} · {formatDuration(data.duration)} · {data.source.replace('_', ' ')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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
            <div ref={playerWrapperRef} className="w-full h-full" />
            <SubtitleOverlay
              segments={segments}
              currentTime={currentTime}
              settings={subtitleSettings}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Click any line on the right to jump to that timestamp. The active
            line highlights as the video plays.
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
              <Select
                value={data.translated_to ?? 'none'}
                onValueChange={(v) => onTranslateTargetChange(v === 'none' ? null : v)}
                disabled={isRefetching}
              >
                <SelectTrigger
                  className="h-7 w-auto gap-1 px-2 text-xs"
                  aria-label="Translate transcript to"
                >
                  <Languages className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="uppercase font-medium">
                    {isRefetching ? '…' : (data.translated_to ?? data.original_language)}
                  </span>
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {TARGET_LANGUAGE_OPTIONS.map((l) => (
                    <SelectItem
                      key={l.code}
                      value={l.code}
                      // Don't offer the source language as a target —
                      // translating bn→bn is a no-op.
                      disabled={l.code === data.original_language && l.code !== 'none'}
                    >
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                      {formatTimestamp(seg.start)}
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

function findActiveSegment(segments: TranscriptSegment[], time: number): number {
  // Binary search for the segment whose [start, start+duration) contains time
  let lo = 0;
  let hi = segments.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const s = segments[mid];
    if (s.start <= time) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return last;
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function segmentsToSubtitles(segments: TranscriptSegment[], format: 'srt' | 'vtt'): string {
  const cueDivider = format === 'srt' ? ',' : '.';
  const fmt = (sec: number) => {
    const total = Math.max(0, Math.round(sec * 1000));
    const ms = total % 1000;
    const totalSec = Math.floor(total / 1000);
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60) % 60;
    const h = Math.floor(totalSec / 3600);
    return `${pad(h)}:${pad(m)}:${pad(s)}${cueDivider}${ms.toString().padStart(3, '0')}`;
  };
  const body = segments
    .map((seg, i) => {
      const start = fmt(seg.start);
      const end = fmt(seg.start + Math.max(0.001, seg.duration));
      const cue = `${start} --> ${end}\n${seg.text.trim()}`;
      return format === 'srt' ? `${i + 1}\n${cue}\n` : `${cue}\n`;
    })
    .join('\n');
  return format === 'vtt' ? `WEBVTT\n\n${body}` : body;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
