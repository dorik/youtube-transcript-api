'use client';

import { useMemo } from 'react';
import type { TranscriptSegment } from '@/lib/api';
import {
  resolveHighlightColor,
  resolveTextColor,
  type SubtitleSettings,
} from '@/lib/subtitle-settings';

interface Props {
  segments: TranscriptSegment[];
  /** Current playback time in seconds. */
  currentTime: number;
  settings: SubtitleSettings;
  /** When 0 segments are active, the overlay renders nothing. */
}

/**
 * Subtitle overlay positioned over the YouTube player. Picks the segments
 * around the current time (1 or 2 depending on settings), optionally
 * highlights the active word, and respects a user-configurable time offset.
 *
 * The overlay does NOT capture pointer events — clicks pass through to the
 * underlying iframe so YouTube's own play / pause controls keep working.
 */
export function SubtitleOverlay({ segments, currentTime, settings }: Props) {
  // Standard subtitle-delay convention: positive offsetMs = subtitles
  // appear LATER than they normally would (delayed). To delay subtitles,
  // at audio time T we render the segment that was active at T - offset.
  // Negative offsetMs advances subtitles (they appear earlier).
  const adjustedTime = currentTime - settings.offsetMs / 1000;

  // Find the active segment (the one whose [start, start+duration) contains
  // the adjusted time). Then optionally include the next one for 2-line mode.
  const activeIdx = useMemo(
    () => findActiveSegment(segments, adjustedTime),
    [segments, adjustedTime],
  );

  if (activeIdx < 0 || segments.length === 0) return null;

  const segmentsToShow: TranscriptSegment[] =
    settings.lines === 2
      ? [segments[activeIdx], segments[activeIdx + 1]].filter(
          (s): s is TranscriptSegment => Boolean(s),
        )
      : [segments[activeIdx]];

  const textColor = resolveTextColor(settings.textColorId);
  const highlightColor = resolveHighlightColor(settings.highlightColorId);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-[12%] flex justify-center px-4"
      aria-hidden
    >
      <div
        className="max-w-[90%] flex flex-col items-center gap-1 text-center"
        style={{ fontSize: `${settings.fontSize}px`, lineHeight: 1.35 }}
      >
        {segmentsToShow.map((seg, i) => {
          // Only the FIRST line gets word-by-word treatment — the upcoming
          // segment is shown as preview text, not animated.
          const isActive = i === 0;
          return (
            <SegmentLine
              key={`${seg.start}-${i}`}
              seg={seg}
              currentTime={adjustedTime}
              textColor={textColor}
              highlightColor={highlightColor}
              background={settings.background}
              wordByWord={settings.wordByWord && isActive}
              dim={!isActive}
            />
          );
        })}
      </div>
    </div>
  );
}

function SegmentLine({
  seg,
  currentTime,
  textColor,
  highlightColor,
  background,
  wordByWord,
  dim,
}: {
  seg: TranscriptSegment;
  currentTime: number;
  textColor: string;
  highlightColor: string;
  background: boolean;
  wordByWord: boolean;
  dim: boolean;
}) {
  const containerStyle: React.CSSProperties = background
    ? {
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        padding: '0.25rem 0.6rem',
        borderRadius: '0.25rem',
      }
    : {
        textShadow:
          '0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.7)',
      };

  if (!wordByWord) {
    return (
      <p
        className="font-semibold"
        style={{
          color: textColor,
          opacity: dim ? 0.65 : 1,
          ...containerStyle,
        }}
      >
        {seg.text}
      </p>
    );
  }

  // Word-by-word: native captions don't ship per-word timestamps, so we
  // estimate by dividing the segment's duration evenly across its words.
  // Imperfect for spoken cadence but matches what most embedded caption
  // players do — including the competitor in the screenshot.
  const words = seg.text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const dur = Math.max(0.001, seg.duration);
  const elapsed = Math.max(0, currentTime - seg.start);
  const wordDur = dur / words.length;
  const activeWordIdx = Math.min(words.length - 1, Math.floor(elapsed / wordDur));

  return (
    <p
      className="font-semibold"
      style={{
        color: textColor,
        opacity: dim ? 0.65 : 1,
        ...containerStyle,
      }}
    >
      {/* Index keys are intentional: words within a single subtitle line
          can repeat ("hello hello") so the word string can't be unique,
          and the array is positionally stable across renders of the same
          line. CLAUDE.md §14.3 exception. */}
      {words.map((word, i) => {
        const isActive = i === activeWordIdx;
        return (
          <span
            key={i}
            style={
              isActive
                ? {
                    backgroundColor: highlightColor,
                    color: '#000',
                    padding: '0 0.1em',
                    borderRadius: '0.15em',
                  }
                : undefined
            }
          >
            {word}
            {i < words.length - 1 && ' '}
          </span>
        );
      })}
    </p>
  );
}

function findActiveSegment(segments: TranscriptSegment[], time: number): number {
  // Same binary search the segment list uses; duplicated here because this
  // component is independent of the right-pane list.
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
