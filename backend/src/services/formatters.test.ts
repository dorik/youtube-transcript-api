import { describe, expect, it } from 'vitest';
import {
  formatShortTimestamp,
  formatSrtTime,
  formatVttTime,
  segmentsToPlainText,
  segmentsToSrt,
  segmentsToTextWithTimestamps,
  segmentsToVtt,
  VALID_FORMATS,
  type Segment,
} from './formatters';

const sample: Segment[] = [
  { start: 0, duration: 2.4, text: 'Welcome to our channel' },
  { start: 2.4, duration: 3.1, text: ' Today we talk about TypeScript ' },
  { start: 5.5, duration: 1.5, text: 'Enjoy!' },
];

describe('formatters / time helpers', () => {
  describe('formatSrtTime', () => {
    it('renders zero', () => {
      expect(formatSrtTime(0)).toBe('00:00:00,000');
    });

    it('renders sub-second milliseconds', () => {
      expect(formatSrtTime(0.123)).toBe('00:00:00,123');
    });

    it('rolls minutes and hours correctly', () => {
      expect(formatSrtTime(3661.5)).toBe('01:01:01,500');
    });

    it('rounds to the nearest millisecond', () => {
      // 1.2345s -> 1234.5ms -> rounds to 1235ms
      expect(formatSrtTime(1.2345)).toBe('00:00:01,235');
    });

    it('clamps negative values to zero', () => {
      expect(formatSrtTime(-5)).toBe('00:00:00,000');
    });
  });

  describe('formatVttTime', () => {
    it('uses a dot separator for milliseconds', () => {
      expect(formatVttTime(3661.5)).toBe('01:01:01.500');
    });

    it('renders zero', () => {
      expect(formatVttTime(0)).toBe('00:00:00.000');
    });
  });

  describe('formatShortTimestamp', () => {
    it('omits hours when under an hour', () => {
      expect(formatShortTimestamp(75)).toBe('01:15');
    });

    it('includes hours when present', () => {
      expect(formatShortTimestamp(3725)).toBe('01:02:05');
    });

    it('renders zero as MM:SS', () => {
      expect(formatShortTimestamp(0)).toBe('00:00');
    });
  });
});

describe('formatters / segment serializers', () => {
  describe('segmentsToPlainText', () => {
    it('joins trimmed segment text with single spaces', () => {
      expect(segmentsToPlainText(sample)).toBe(
        'Welcome to our channel Today we talk about TypeScript Enjoy!',
      );
    });

    it('drops empty segments after trimming', () => {
      const withEmpty: Segment[] = [
        { start: 0, duration: 1, text: 'hello' },
        { start: 1, duration: 1, text: '   ' },
        { start: 2, duration: 1, text: 'world' },
      ];
      expect(segmentsToPlainText(withEmpty)).toBe('hello world');
    });

    it('returns empty string for empty input', () => {
      expect(segmentsToPlainText([])).toBe('');
    });
  });

  describe('segmentsToTextWithTimestamps', () => {
    it('prefixes every line with a short timestamp', () => {
      expect(segmentsToTextWithTimestamps(sample)).toBe(
        '[00:00] Welcome to our channel\n[00:02] Today we talk about TypeScript\n[00:05] Enjoy!',
      );
    });

    it('uses HH:MM:SS once a segment crosses one hour', () => {
      const long: Segment[] = [{ start: 3725, duration: 1, text: 'late' }];
      expect(segmentsToTextWithTimestamps(long)).toBe('[01:02:05] late');
    });
  });

  describe('segmentsToSrt', () => {
    it('produces 1-indexed cue blocks with --> arrows', () => {
      const out = segmentsToSrt(sample);
      expect(out).toContain('1\n00:00:00,000 --> 00:00:02,400\nWelcome to our channel');
      expect(out).toContain('2\n00:00:02,400 --> 00:00:05,500\nToday we talk about TypeScript');
      expect(out).toContain('3\n00:00:05,500 --> 00:00:07,000\nEnjoy!');
    });

    it('emits a minimum 1ms duration when duration is zero or negative', () => {
      const zero: Segment[] = [{ start: 0, duration: 0, text: 'tick' }];
      expect(segmentsToSrt(zero)).toContain('00:00:00,000 --> 00:00:00,001\ntick');
    });

    it('returns empty string for empty input', () => {
      expect(segmentsToSrt([])).toBe('');
    });
  });

  describe('segmentsToVtt', () => {
    it('starts with the WEBVTT header', () => {
      expect(segmentsToVtt(sample).startsWith('WEBVTT\n\n')).toBe(true);
    });

    it('uses dot-separated cue times', () => {
      const out = segmentsToVtt(sample);
      expect(out).toContain('00:00:00.000 --> 00:00:02.400\nWelcome to our channel');
      expect(out).toContain('00:00:05.500 --> 00:00:07.000\nEnjoy!');
    });

    it('still includes the header for empty input', () => {
      expect(segmentsToVtt([])).toBe('WEBVTT\n\n');
    });
  });
});

describe('formatters / VALID_FORMATS', () => {
  it('exposes the five supported formats', () => {
    expect(VALID_FORMATS).toEqual(['json', 'text', 'text-timestamps', 'srt', 'vtt']);
  });
});
