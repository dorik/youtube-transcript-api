import type { TranscriptSegment } from '@/lib/api';

export function findActiveSegment(segments: TranscriptSegment[], time: number): number {
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

export function formatDuration(seconds: number): string {
  if (!seconds) return '-';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function segmentsToSubtitles(
  segments: TranscriptSegment[],
  format: 'srt' | 'vtt',
): string {
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
