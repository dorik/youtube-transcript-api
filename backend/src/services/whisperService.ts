import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import OpenAI from 'openai';
import {config} from '../config/env';
import {logger} from '../config/logger';
import {UpgradeRequiredError} from '../utils/errors';
import {Segment} from './formatters';
import {mapYtDlpError, ytDlpNetworkArgs} from './youtubeService';
import {normalizeLanguageCode} from '../utils/languageCodes';

const execFileAsync = promisify(execFile);

export interface WhisperResult {
	videoId: string;
	segments: Segment[];
	language: string;
	durationSeconds: number;
	source: 'whisper';
}

export interface TranscribeWithWhisperOptions {
	/**
	 * Whether the caller's plan is allowed to use Whisper. The orchestrator
	 * (`transcriptService`) is the source of truth for this gate — it short-
	 * circuits before reaching us, so by the time we run this is expected to
	 * be `true`. The defensive check below still throws if a future caller
	 * forgets, so the failure mode is "no Whisper" rather than "free user
	 * silently consumed OpenAI quota".
	 *
	 * Default `false` — fails closed if the caller forgets to opt in.
	 */
	allowRealWhisper?: boolean;
}

/**
 * Transcribe a YouTube video by downloading audio with yt-dlp and shipping
 * the file to OpenAI's Whisper.
 *
 * Callers MUST gate by plan before invoking this — the orchestrator does so
 * and throws `UpgradeRequiredError` with a contextual message at that layer.
 * We keep a fail-closed check here to protect against new call sites that
 * forget to pass `allowRealWhisper: true`.
 */
export async function transcribeWithWhisper(
	videoId: string,
	language?: string,
	options: TranscribeWithWhisperOptions = {},
): Promise<WhisperResult> {
	if (!(options.allowRealWhisper ?? false)) {
		// Defensive: in normal flow the orchestrator throws UpgradeRequiredError
		// with a richer message ("No native captions are available…") before we
		// ever get here. If we DO get here, it's a caller bug — fail closed.
		throw new UpgradeRequiredError('AI transcription');
	}
	if (!config.OPENAI_API_KEY) {
		throw new Error('OPENAI_API_KEY is required for Whisper transcription');
	}

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-whisper-'));
	const audioPath = path.join(tempDir, `${videoId}.mp3`);

	try {
		logger.info({videoId}, 'Whisper: extracting audio with yt-dlp');
		try {
			await execFileAsync(
				'yt-dlp',
				[
					'-f',
					'bestaudio',
					'-x',
					'--audio-format',
					'mp3',
					'--audio-quality',
					'192K',
					'-o',
					audioPath,
					// Apply the same proxy/cookie config as the caption path —
					// otherwise the audio download still egresses from the bare
					// server IP and hits YouTube's bot wall.
					...ytDlpNetworkArgs(),
					`https://www.youtube.com/watch?v=${videoId}`,
				],
				{timeout: 120_000},
			);
		} catch (err) {
			logger.info({error: err}, 'billal');
			// Route bot-challenges / video-removed / etc. through the shared
			// mapper. Without this, the raw execFile rejection bubbled up to the
			// express error handler as an opaque 500 ("Unhandled error").
			throw mapYtDlpError(err, videoId, 'whisper-audio');
		}
		logger.info({audioPath, exists: fs.existsSync(audioPath)}, 'billal');
		const stat = fs.statSync(audioPath);
		if (stat.size > 25 * 1024 * 1024) {
			throw new Error(
				`Audio file too large for Whisper API (${(stat.size / 1024 / 1024).toFixed(1)} MB > 25 MB).`,
			);
		}

		const {stdout: durationStr} = await execFileAsync('ffprobe', [
			'-v',
			'error',
			'-show_entries',
			'format=duration',
			'-of',
			'default=noprint_wrappers=1:nokey=1',
			audioPath,
		]);
		const durationSeconds = Math.ceil(parseFloat(durationStr.trim())) || 0;

		const openai = new OpenAI({apiKey: config.OPENAI_API_KEY});

		logger.info({videoId, language, durationSeconds}, 'Whisper: calling OpenAI API');
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
			segments?: Array<{start: number; end: number; text: string}>;
		};

		const segments: Segment[] = verbose.segments?.map((s) => ({
			start: s.start,
			duration: Math.max(0.001, s.end - s.start),
			text: s.text.trim(),
		})) ?? [{start: 0, duration: durationSeconds, text: verbose.text}];
		// Whisper's verbose_json returns the detected language as a lowercase
		// English NAME (e.g. "bengali", "english"), not an ISO code. Normalize
		// at the boundary so downstream equality checks against ISO codes
		// (translate_to, cache keys, user input) actually work.
		const normalized =
			normalizeLanguageCode(verbose.language) ||
			normalizeLanguageCode(language) ||
			'en';

		return {
			videoId,
			segments,
			language: normalized,
			durationSeconds,
			source: 'whisper',
		};
	} finally {
		// Best-effort cleanup
		fs.rm(tempDir, {recursive: true, force: true}, (err) => {
			if (err)
				logger.warn(
					{err, tempDir},
					'Whisper: failed to clean up temp dir',
				);
		});
	}
}
