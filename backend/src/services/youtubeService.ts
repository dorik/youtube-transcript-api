import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import axios from 'axios';
import {config} from '../config/env';
import {logger} from '../config/logger';
import {
	NoTranscriptError,
	UpstreamBlockedError,
	VideoNotFoundError,
} from '../utils/errors';
import {Segment} from './formatters';

const execFileAsync = promisify(execFile);

/**
 * Defensive concurrency cap for yt-dlp subprocesses on this path.
 *
 * Each yt-dlp run uses ~50–100 MB of RAM while it parses the watch page.
 * The Render free instance has 512 MB total, so an unguarded burst (e.g. a
 * batch caller hitting us with 20 videos at once) would OOM-kill the
 * process. Three concurrent extractions is comfortably within budget and
 * still fully serializes per-user requests on a single CPU. Bump on a
 * larger plan.
 */
const MAX_CONCURRENT_YTDLP = 3;

export interface YouTubeFetchResult {
	videoId: string;
	segments: Segment[];
	language: string;
	durationSeconds: number;
	source: 'native_captions';
}

export interface YouTubeMetadata {
	videoId: string;
	title: string;
	channel: string;
	thumbnailUrl: string | null;
}

// ── yt-dlp output shapes ────────────────────────────────────────────────────
// yt-dlp's `--dump-single-json` emits everything it knows about the video.
// We only need the caption catalogs and the duration; the rest of the dump
// is discarded.

interface YtDlpCaptionTrack {
	ext: string;
	url: string;
	name?: string;
}

interface YtDlpDump {
	id: string;
	duration?: number;
	/** Manually authored caption tracks, keyed by language tag. */
	subtitles?: Record<string, YtDlpCaptionTrack[]>;
	/**
	 * Auto-generated tracks (Whisper-on-YouTube). Includes both the original
	 * recognised language (e.g. `en`, `en-orig`) AND auto-translated variants
	 * the YouTube UI offers (`en-fr`, `en-de`, ...). We deliberately skip the
	 * machine-translated variants — they're noisy and the user is better
	 * served by the genuine source-language track.
	 */
	automatic_captions?: Record<string, YtDlpCaptionTrack[]>;
}

/** YouTube's `json3` timed-text format. */
interface Json3Caption {
	events?: Array<{
		tStartMs?: number;
		dDurationMs?: number;
		/** Text fragments that get concatenated into the final caption text. */
		segs?: Array<{utf8?: string}>;
	}>;
}

/**
 * Fetch native YouTube captions for a video.
 *
 * Backed by yt-dlp instead of the unmaintained `youtube-transcript` npm
 * package — yt-dlp is patched within hours of YouTube frontend changes
 * and has first-class proxy support, which matters on shared datacenter
 * IPs (Render, etc.) where YouTube is increasingly aggressive about
 * bot challenges.
 *
 * Strategy: ask yt-dlp for the dump JSON (one HTTPS round-trip to the
 * watch page), pick the best-matching caption track from its catalogs,
 * then fetch that track directly as `json3`. No subtitle file is written
 * to disk — we keep the whole flow in-memory.
 *
 * - When `language` is undefined or 'auto', any available track is
 *   acceptable; manual tracks beat auto-generated ones.
 * - When a specific language is requested but not available, we fall back
 *   to whatever genuine track exists (parity with the previous library's
 *   behaviour). Users prefer "wrong language" over "no transcript".
 *
 * Throws:
 * - `NoTranscriptError` — captions are disabled or unavailable. Caller may
 *   fall back to Whisper.
 * - `VideoNotFoundError` — video does not exist / is private / was removed.
 * - `UpstreamBlockedError` — YouTube is throttling us (HTTP 429) or serving
 *   the "Sign in to confirm you're not a bot" challenge. Falling back to
 *   Whisper won't help — both yt-dlp paths share the same egress IP, so the
 *   audio download will hit the same wall. Operator needs to set PROXY_URL
 *   or YT_COOKIES_PATH.
 */
export async function fetchYouTubeCaptions(
	videoId: string,
	language?: string,
): Promise<YouTubeFetchResult> {
	const requestedLang =
		language && language !== 'auto' && language.trim()
			? language
			: undefined;

	return runWithLimit(async () => {
		const dump = await dumpVideoInfo(videoId);
		const pick = pickCaptionTrack(dump, requestedLang);
		if (!pick) {
			throw new NoTranscriptError(videoId);
		}

		const segments = await fetchAndParseJson3(pick.url, videoId);
		if (!segments.length) {
			// yt-dlp gave us a caption URL but the body was empty / unparseable.
			// Treat as if no transcript exists so the caller can fall back.
			throw new NoTranscriptError(videoId);
		}

		// Prefer the duration yt-dlp reported (precise, taken from the player
		// config). Fall back to inferring from the last segment when the dump
		// omits it (rare; happens for ongoing live streams).
		const last = segments[segments.length - 1];
		const durationSeconds =
			typeof dump.duration === 'number' && dump.duration > 0
				? Math.ceil(dump.duration)
				: Math.ceil(last.start + last.duration);

		if (requestedLang && pick.lang !== requestedLang) {
			logger.info(
				{
					videoId,
					requested: requestedLang,
					served: pick.lang,
					source: pick.source,
				},
				'Requested caption language unavailable; served best alternative track',
			);
		}

		return {
			videoId,
			segments,
			language: pick.lang,
			durationSeconds,
			source: 'native_captions',
		};
	});
}

/**
 * Run yt-dlp with `--dump-single-json` to extract the watch-page metadata
 * (including subtitle URLs). No video bytes are downloaded; this is just a
 * single GET to the watch page plus YouTube player-config decoding inside
 * yt-dlp. Typical wall time: 0.5–2s on a warm process.
 */
async function dumpVideoInfo(videoId: string): Promise<YtDlpDump> {
	const args = [
		`https://www.youtube.com/watch?v=${videoId}`,
		'--skip-download',
		'--dump-single-json',
		'--no-warnings',
		// Defensive: a stray `&list=` in the URL would otherwise trigger a
		// playlist walk we don't want.
		'--no-playlist',
		...ytDlpNetworkArgs(),
	];

	let stdout: string;
	try {
		const result = await execFileAsync('yt-dlp', args, {
			timeout: 30_000,
			// The dump can be large for popular videos (hundreds of auto-translated
			// caption entries, full chapter list, etc.). 50 MB is plenty.
			maxBuffer: 50 * 1024 * 1024,
		});
		stdout = result.stdout;
	} catch (err) {
		throw mapYtDlpError(err, videoId);
	}

	try {
		return JSON.parse(stdout) as YtDlpDump;
	} catch (err) {
		logger.error({err, videoId}, 'yt-dlp dump produced unparseable JSON');
		throw new NoTranscriptError(videoId);
	}
}

interface PickedTrack {
	lang: string;
	url: string;
	source: 'manual' | 'auto';
}

/**
 * Choose the best caption track from yt-dlp's catalogs.
 *
 * Order of preference:
 *  1. Requested language, manual track (best quality, human-authored).
 *  2. Requested language, auto-generated track.
 *  3. Any genuine manual track (matches old library behaviour: a user asking
 *     for `en` on a Bangla-only video gets Bangla rather than nothing).
 *  4. Any genuine auto-generated track.
 *
 * Auto-translated variants (e.g. `en-fr` = English caption auto-translated
 * from French) are deliberately excluded — they're machine translations
 * layered on top of machine recognition, and the resulting quality is
 * worse than serving the source-language track directly.
 */
function pickCaptionTrack(
	dump: YtDlpDump,
	requestedLang: string | undefined,
): PickedTrack | null {
	const manual = dump.subtitles ?? {};
	const auto = dump.automatic_captions ?? {};

	return (
		pickByLang(manual, requestedLang, 'manual') ??
		pickByLang(auto, requestedLang, 'auto') ??
		pickAny(manual, 'manual') ??
		pickAny(auto, 'auto')
	);
}

function pickByLang(
	catalog: Record<string, YtDlpCaptionTrack[]>,
	lang: string | undefined,
	source: 'manual' | 'auto',
): PickedTrack | null {
	if (!lang) return null;
	const keys = Object.keys(catalog);

	// Exact match wins (e.g. requested `en`, catalog has `en`).
	const exact = keys.find((k) => k === lang);
	if (exact) {
		const url = trackUrl(catalog[exact]);
		if (url) return {lang: exact, url, source};
	}

	// Then a region-stripped match (e.g. requested `en`, catalog has `en-US`,
	// or vice versa). Skip auto-translated variants when matching by prefix.
	const requestedBase = lang.split(/[-_]/)[0];
	const prefix = keys.find(
		(k) =>
			!isAutoTranslatedVariant(k) && k.split(/[-_]/)[0] === requestedBase,
	);
	if (prefix) {
		const url = trackUrl(catalog[prefix]);
		if (url) return {lang: prefix, url, source};
	}

	return null;
}

function pickAny(
	catalog: Record<string, YtDlpCaptionTrack[]>,
	source: 'manual' | 'auto',
): PickedTrack | null {
	for (const [lang, tracks] of Object.entries(catalog)) {
		if (isAutoTranslatedVariant(lang)) continue;
		const url = trackUrl(tracks);
		if (url) return {lang, url, source};
	}
	return null;
}

/**
 * YouTube exposes auto-translation by listing keys like `en-fr`, `en-de`,
 * one for every UI translation target. The pattern is two lowercase letters
 * + dash + two lowercase letters. Genuine region tags (`en-US`, `pt-BR`)
 * use uppercase, and the original-language marker (`en-orig`) uses a longer
 * suffix, so neither is matched here.
 */
function isAutoTranslatedVariant(lang: string): boolean {
	return /^[a-z]{2}-[a-z]{2}$/.test(lang);
}

/**
 * Pick the json3 variant of a track when present. yt-dlp lists tracks in
 * multiple formats (json3, srv1, srv2, srv3, ttml, vtt). json3 is the
 * canonical YouTube format and the easiest to parse; everything else falls
 * back to URL-rewriting in `fetchAndParseJson3`.
 */
function trackUrl(tracks: YtDlpCaptionTrack[] | undefined): string | null {
	if (!tracks?.length) return null;
	const json3 = tracks.find((t) => t.ext === 'json3');
	return (json3 ?? tracks[0]).url;
}

/**
 * Fetch a single caption track directly from YouTube's timed-text endpoint
 * and parse the json3 response into our internal `Segment` shape.
 *
 * The URL yt-dlp embeds in its dump already carries the short-lived signing
 * parameters required by YouTube's timed-text service, so this is a plain
 * HTTPS GET — no further auth or extraction needed.
 */
async function fetchAndParseJson3(
	url: string,
	videoId: string,
): Promise<Segment[]> {
	// If the URL was for a non-json3 format, force json3 — the timed-text
	// endpoint accepts `&fmt=json3` for any track, regardless of the format
	// yt-dlp originally listed it under.
	const u = new URL(url);
	if (u.searchParams.get('fmt') !== 'json3')
		u.searchParams.set('fmt', 'json3');

	let body: Json3Caption;
	try {
		const {data} = await axios.get<Json3Caption>(u.toString(), {
			timeout: 12_000,
			// YouTube serves json3 as text/plain occasionally; force the JSON
			// parser so we don't end up with a string.
			responseType: 'json',
			transformResponse: (raw: unknown) => {
				if (typeof raw !== 'string') return raw;
				try {
					return JSON.parse(raw);
				} catch {
					return {};
				}
			},
		});
		body = data ?? {};
	} catch (err) {
		logger.warn({err, videoId}, 'Caption track fetch failed');
		throw new NoTranscriptError(videoId);
	}

	const events = body.events ?? [];
	const segments: Segment[] = [];
	for (const event of events) {
		const text = (event.segs ?? [])
			.map((s) => s.utf8 ?? '')
			.join('')
			// json3 caption events sometimes contain literal newlines as line
			// breaks within a single phrase. Collapse them so downstream
			// formatters don't accidentally insert paragraph breaks mid-segment.
			.replace(/\s+/g, ' ')
			.trim();
		if (!text) continue;
		segments.push({
			start: (event.tStartMs ?? 0) / 1000,
			// dDurationMs is occasionally missing on the very last event for live
			// streams. A non-zero duration keeps SRT/VTT renderers happy.
			duration: Math.max(0.001, (event.dDurationMs ?? 0) / 1000),
			text,
		});
	}
	return segments;
}

/**
 * Build the proxy/cookie args shared by every yt-dlp invocation in this app.
 *
 * Kept as a function (not a constant) because `config` is loaded once at
 * boot — using a function lets us defensively re-read on each call without
 * tying tests to module-import order.
 */
export function ytDlpNetworkArgs(): string[] {
	const args: string[] = [];
	if (config.PROXY_URL) {
		args.push('--proxy', config.PROXY_URL);
	}
	if (config.YT_COOKIES_PATH) {
		// The only knob YouTube currently respects for "Sign in to confirm
		// you're not a bot" without an IP rotation. Path must point at a
		// Netscape-format cookies file the process can read.
		args.push('--cookies', config.YT_COOKIES_PATH);
	}
	return args;
}

/**
 * Translate a yt-dlp subprocess failure into one of our domain errors.
 *
 * yt-dlp doesn't expose structured exit codes for these conditions — we have
 * to grep its stderr. The patterns below are stable across recent yt-dlp
 * releases; if YouTube changes the wording, new branches go here.
 *
 * `context` is used only for the fallback log line — pass 'captions' or
 * 'whisper-audio' so triage can tell which yt-dlp path failed.
 */
export function mapYtDlpError(
	err: unknown,
	videoId: string,
	context: 'captions' | 'whisper-audio' = 'captions',
): Error {
	const stderr =
		isExecError(err) && typeof err.stderr === 'string' ? err.stderr : '';
	const message = err instanceof Error ? err.message : String(err);
	const blob = `${stderr}\n${message}`.toLowerCase();

	// Diagnostic: every yt-dlp failure (caption path + whisper-audio path)
	// passes through here. The raw stderr is what YouTube literally
	// returned, so this is the ground truth for "is YouTube blocking us
	// or is our code misbehaving". Search Render logs for "billal" to
	// pull these lines. `args` is intentionally NOT logged — when
	// PROXY_URL is set it contains proxy credentials in plaintext.
	logger.warn(
		{
			marker: 'billal',
			videoId,
			context,
			blob,
			proxyConfigured: Boolean(config.PROXY_URL),
			cookiesConfigured: Boolean(config.YT_COOKIES_PATH),
			exitCode: isExecError(err) ? err.code : undefined,
			stderr: stderr.slice(0, 1500),
			messageHead: message.slice(0, 300),
		},
		'billal: yt-dlp failed',
	);

	if (
		blob.includes('video unavailable') ||
		blob.includes('private video') ||
		blob.includes('removed by the uploader') ||
		blob.includes('this video is not available') ||
		blob.includes('does not exist')
	) {
		return new VideoNotFoundError(videoId);
	}
	if (
		blob.includes('http error 429') ||
		blob.includes('too many requests') ||
		// YouTube's anti-bot challenge — different wording across yt-dlp versions
		// and YouTube locales. Both straight and curly apostrophes appear.
		blob.includes("sign in to confirm you're not a bot") ||
		blob.includes('sign in to confirm you’re not a bot') ||
		blob.includes('sign in to confirm your age')
	) {
		return new UpstreamBlockedError(60);
	}

	// Truncate stderr in the log line — yt-dlp can produce many KB of debug
	// output and we only need the first error line for triage.
	logger.warn(
		{err, videoId, context, stderr: stderr.slice(0, 500)},
		'yt-dlp call failed; treating as no-transcript',
	);
	return new NoTranscriptError(videoId);
}

function isExecError(
	err: unknown,
): err is {stderr?: string; stdout?: string; code?: number | string} {
	return (
		typeof err === 'object' &&
		err !== null &&
		('stderr' in err || 'code' in err)
	);
}

// ── Concurrency limiter ─────────────────────────────────────────────────────
// Tiny FIFO semaphore. Avoids a `p-limit` dependency for ~10 lines of code.
// All in-flight fetches share this single counter — the limiter is module-
// scoped, not per-call.

let activeYtDlp = 0;
const ytDlpQueue: Array<() => void> = [];

async function runWithLimit<T>(fn: () => Promise<T>): Promise<T> {
	if (activeYtDlp >= MAX_CONCURRENT_YTDLP) {
		await new Promise<void>((resolve) => ytDlpQueue.push(resolve));
	}
	activeYtDlp += 1;
	try {
		return await fn();
	} finally {
		activeYtDlp -= 1;
		const next = ytDlpQueue.shift();
		if (next) next();
	}
}

// ── Metadata ────────────────────────────────────────────────────────────────

/**
 * Fetch lightweight video metadata via oEmbed. No API key required.
 *
 * oEmbed gives us title + author + thumbnail but NOT duration; for native
 * captions we infer duration from segments. For Whisper, duration comes
 * from ffprobe on the downloaded audio.
 *
 * Kept as oEmbed (rather than rolled into the yt-dlp dump above) on
 * purpose — oEmbed is a first-party YouTube API, doesn't count against
 * scraping budgets, and is by far the cheapest path for the metadata-only
 * callers in `youtubeBrowseService.ts`.
 */
export async function fetchYouTubeMetadata(
	videoId: string,
): Promise<YouTubeMetadata> {
	try {
		const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
		const {data} = await axios.get(url, {timeout: 8_000});
		return {
			videoId,
			title: typeof data.title === 'string' ? data.title : 'Untitled',
			channel:
				typeof data.author_name === 'string'
					? data.author_name
					: 'Unknown',
			thumbnailUrl:
				typeof data.thumbnail_url === 'string'
					? data.thumbnail_url
					: null,
		};
	} catch (err) {
		logger.warn(
			{err, videoId},
			'oEmbed metadata fetch failed; using placeholders',
		);
		return {
			videoId,
			title: 'Untitled',
			channel: 'Unknown',
			thumbnailUrl: null,
		};
	}
}
