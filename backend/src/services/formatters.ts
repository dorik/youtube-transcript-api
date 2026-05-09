/**
 * Convert internal segment representation to user-facing transcript formats.
 *
 * Segments use seconds (floating point); SRT/VTT timestamps are HH:MM:SS,mmm
 * or HH:MM:SS.mmm. We round to the nearest millisecond.
 */

export interface Segment {
  start: number; // seconds
  duration: number; // seconds
  text: string;
}

export type OutputFormat = 'json' | 'text' | 'text-timestamps' | 'srt' | 'vtt';

export const VALID_FORMATS: OutputFormat[] = [
  'json',
  'text',
  'text-timestamps',
  'srt',
  'vtt',
];

/**
 * Format helpers
 */

function pad(n: number, width: number): string {
  return n.toString().padStart(width, '0');
}

function splitParts(seconds: number) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return { h, m, s, ms };
}

export function formatSrtTime(seconds: number): string {
  const { h, m, s, ms } = splitParts(seconds);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

export function formatVttTime(seconds: number): string {
  const { h, m, s, ms } = splitParts(seconds);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/**
 * Display short timestamp [HH:MM:SS] (or [MM:SS] when no hours).
 */
export function formatShortTimestamp(seconds: number): string {
  const { h, m, s } = splitParts(seconds);
  if (h > 0) return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`;
  return `${pad(m, 2)}:${pad(s, 2)}`;
}

export function segmentsToPlainText(segments: Segment[]): string {
  return segments.map((s) => s.text.trim()).filter(Boolean).join(' ');
}

export function segmentsToTextWithTimestamps(segments: Segment[]): string {
  return segments
    .map((seg) => `[${formatShortTimestamp(seg.start)}] ${seg.text.trim()}`)
    .join('\n');
}

export function segmentsToSrt(segments: Segment[]): string {
  return segments
    .map((seg, i) => {
      const start = formatSrtTime(seg.start);
      const end = formatSrtTime(seg.start + Math.max(seg.duration, 0.001));
      return `${i + 1}\n${start} --> ${end}\n${seg.text.trim()}\n`;
    })
    .join('\n');
}

export function segmentsToVtt(segments: Segment[]): string {
  const body = segments
    .map((seg) => {
      const start = formatVttTime(seg.start);
      const end = formatVttTime(seg.start + Math.max(seg.duration, 0.001));
      return `${start} --> ${end}\n${seg.text.trim()}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
