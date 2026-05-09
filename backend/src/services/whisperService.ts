import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI from 'openai';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { Segment } from './formatters';

const execFileAsync = promisify(execFile);

export interface WhisperResult {
  videoId: string;
  segments: Segment[];
  language: string;
  durationSeconds: number;
  source: 'whisper';
}

/**
 * Transcribe a YouTube video by downloading audio with yt-dlp and shipping
 * the file to OpenAI's Whisper.
 *
 * When `STUB_WHISPER=true`, we return a single canned segment instead. This
 * lets the rest of the pipeline (credits, caching, formatters) be fully
 * exercised end-to-end without paying for / configuring OpenAI in dev.
 */
export async function transcribeWithWhisper(
  videoId: string,
  language?: string,
): Promise<WhisperResult> {
  if (config.STUB_WHISPER) {
    return stubResult(videoId, language);
  }
  return realWhisper(videoId, language);
}

function stubResult(videoId: string, language?: string): WhisperResult {
  // 30 seconds of canned content split into two segments. Enough for
  // formatters, SRT/VTT, and credit math (1 minute → 1 credit) to look real.
  return {
    videoId,
    segments: [
      {
        start: 0,
        duration: 15,
        text: `[Stubbed Whisper transcription for ${videoId}]`,
      },
      {
        start: 15,
        duration: 15,
        text: 'Set STUB_WHISPER=false and provide OPENAI_API_KEY for the real thing.',
      },
    ],
    language: language ?? 'en',
    durationSeconds: 30,
    source: 'whisper',
  };
}

async function realWhisper(videoId: string, language?: string): Promise<WhisperResult> {
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when STUB_WHISPER=false');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-whisper-'));
  const audioPath = path.join(tempDir, `${videoId}.mp3`);

  try {
    logger.info({ videoId }, 'Whisper: extracting audio with yt-dlp');
    await execFileAsync(
      'yt-dlp',
      [
        '-f', 'bestaudio',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '-o', audioPath,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: 120_000 },
    );

    const stat = fs.statSync(audioPath);
    if (stat.size > 25 * 1024 * 1024) {
      throw new Error(
        `Audio file too large for Whisper API (${(stat.size / 1024 / 1024).toFixed(1)} MB > 25 MB).`,
      );
    }

    const { stdout: durationStr } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ]);
    const durationSeconds = Math.ceil(parseFloat(durationStr.trim())) || 0;

    const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

    logger.info({ videoId, durationSeconds }, 'Whisper: calling OpenAI API');
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      language: language && language !== 'auto' ? language : undefined,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    const verbose = response as unknown as {
      text: string;
      language: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };

    const segments: Segment[] =
      verbose.segments?.map((s) => ({
        start: s.start,
        duration: Math.max(0.001, s.end - s.start),
        text: s.text.trim(),
      })) ?? [{ start: 0, duration: durationSeconds, text: verbose.text }];

    return {
      videoId,
      segments,
      language: verbose.language || language || 'en',
      durationSeconds,
      source: 'whisper',
    };
  } finally {
    // Best-effort cleanup
    fs.rm(tempDir, { recursive: true, force: true }, (err) => {
      if (err) logger.warn({ err, tempDir }, 'Whisper: failed to clean up temp dir');
    });
  }
}

/**
 * Whisper credits: 1 credit per minute of audio (rounded up).
 */
export function whisperCreditCost(durationSeconds: number): number {
  return Math.max(1, Math.ceil(durationSeconds / 60));
}
