import {extractVideoId, buildWatchUrl} from '../utils/youtubeUrl';
import {fetchYouTubeCaptions, fetchYouTubeMetadata} from './youtubeService';
import {transcribeWithWhisper} from './whisperService';
import {
	getCached,
	setCached,
	getCachedTranslation,
	setCachedTranslation,
	CachedTranscript,
} from './cacheService';
import {deductCredits, getCreditState} from './creditService';
import {translateSegments} from './translationService';
import {getUserSubscription, isPaidPlan} from './stripeService';
import {
	OutputFormat,
	Segment,
	segmentsToPlainText,
	segmentsToSrt,
	segmentsToTextWithTimestamps,
	segmentsToVtt,
} from './formatters';
import {
	ApiError,
	NoTranscriptError,
	PaymentRequiredError,
	UpgradeRequiredError,
	UpstreamBlockedError,
	ValidationError,
} from '../utils/errors';
import {logger} from '../config/logger';
import {config} from '../config/env';
import {normalizeLanguageCode} from '../utils/languageCodes';

export interface TranscriptResponse {
	video_id: string;
	url: string;
	title: string;
	channel: string;
	duration: number;
	/**
	 * Language of the transcript text the user is currently seeing.
	 * - For untranslated: equals `original_language`.
	 * - For translated: equals `translated_to`.
	 */
	language: string;
	/** Native language YouTube/Whisper produced (always present). */
	original_language: string;
	/** Target language if a translation was applied; otherwise null. */
	translated_to: string | null;
	source: 'native_captions' | 'whisper';
	format: OutputFormat;
	/**
	 * Format-specific. JSON => string of full text + `segments` array.
	 * Other formats => the formatted string only.
	 */
	transcript: string;
	segments?: Segment[];
	/**
	 * The untranslated transcript / segments. Only populated when a
	 * translation was applied — lets the viewer offer an "Original ⇄
	 * Translated" toggle without making a second API call. Same timestamps
	 * as `segments` because we preserve timing during translation.
	 */
	original_transcript?: string;
	original_segments?: Segment[];
	credits_used: number;
	credits_remaining: number;
	cached: boolean;
	fetched_at: string;
}

export interface GetTranscriptInput {
	userId: string;
	url: string;
	format: OutputFormat;
	language?: string; // 'auto' or undefined => let YouTube decide
	/**
	 * When true, skip the Whisper fallback. If the video has no native
	 * captions, fail with NoTranscriptError instead of charging per-minute.
	 * Useful for billing-conscious callers who only want native captions.
	 */
	nativeOnly?: boolean;
	/**
	 * Optional ISO 639-1 code. When set and different from the source
	 * language, the transcript is translated and an extra credit is charged.
	 * 'none' / undefined / equal-to-source means "no translation".
	 */
	translateTo?: string;
}

/**
 * Orchestrates the full /v1/transcript flow:
 *
 *  1. Parse video id, normalize requested language and translate target.
 *  2. Cache hit on the original → reuse it; otherwise fetch native captions
 *     (with Whisper fallback) and cache.
 *  3. If `translate_to` is set and differs from the original language,
 *     check the translation cache. Hit → reuse translated segments, no
 *     credit deducted. Miss → translate the segments, charge +1 credit,
 *     and write the result back to the cache so the next caller skips both.
 *  4. Format the response (JSON / text / SRT / VTT / text-timestamps).
 */
export async function getTranscript(
	input: GetTranscriptInput,
): Promise<TranscriptResponse> {
	const videoId = extractVideoId(input.url);
	// 'auto' is our marker for "let YouTube pick whatever track is available".
	// Previously this defaulted to 'en', which silently broke any video that
	// didn't have an English caption track (e.g. a Bangla news video).
	// User input is normalized to canonical ISO 639-1 codes before any
	// downstream comparison or cache lookup. Without this, an API caller
	// passing `language=english` or `translate_to=Bengali` would write
	// transcripts into cache keys nobody else would ever hit, and the
	// `translateTo !== original.language` check below would flip to true
	// even when the languages are semantically identical. See
	// `utils/languageCodes.ts` for the full map and the reason it exists.
	const requestedLanguage =
		input.language && input.language.trim() && input.language !== 'auto'
			? normalizeLanguageCode(input.language) || input.language.trim()
			: 'auto';

	const translateTo =
		input.translateTo &&
		input.translateTo.trim() &&
		input.translateTo !== 'none' &&
		input.translateTo !== 'auto'
			? normalizeLanguageCode(input.translateTo) ||
				input.translateTo.trim()
			: null;

	// Real OpenAI Whisper is a paid-only feature. We look this up once up
	// front because it's needed by both the original-fetch path (cache miss
	// below) and the translate-to native-Whisper attempt later. One small
	// DB query buys us a clean signature on both code paths.
	const subscription = await getUserSubscription(input.userId);
	const allowRealWhisper = isPaidPlan(subscription?.plan_id);

	// 1. Cache check for the ORIGINAL transcript. The user's request key is
	//    used directly; explicit-language requests are served from a
	//    per-language alias written after a fresh fetch.
	//
	// Billing policy: one HTTP request → at most 1 credit deducted, ever.
	// Multiple internal operations (Whisper, native-in-target, MT) all
	// coalesce into a single 1-credit charge at the end of this function.
	// Pure cache paths (original + translation both cached) cost 0.
	let original: CachedTranscript;
	let didFreshWork = false;

	const cached = await getCached(videoId, requestedLanguage);
	if (cached) {
		original = cached;
	} else {
		// Pre-flight check: refuse upstream work for a user who can't pay even
		// 1 credit. The transactional deductCredits at the end is the real
		// guard; this just avoids burning a YouTube fetch / Whisper call for a
		// 0-credit user.
		const stateBefore = await getCreditState(input.userId);
		if (stateBefore.balance < 1) {
			throw new PaymentRequiredError(1, stateBefore.balance);
		}

		const fetched = await fetchTranscript(
			videoId,
			requestedLanguage,
			input.nativeOnly ?? false,
			allowRealWhisper,
		);
		const metadata = await fetchYouTubeMetadata(videoId);
		didFreshWork = true;

		const actualLanguage = fetched.language || requestedLanguage;
		original = {
			videoId,
			language: actualLanguage,
			title: metadata.title,
			channel: metadata.channel,
			durationSeconds: fetched.durationSeconds,
			source: fetched.source,
			transcript: segmentsToPlainText(fetched.segments),
			segments: fetched.segments,
			cachedAt: new Date().toISOString(),
		};

		// Cache under the actual language YouTube/Whisper gave us. Aliasing
		// under the *requested* key is only safe when the user explicitly asked
		// for 'auto' — that's a sentinel meaning "any language is fine", so a
		// future 'auto' lookup should hit the same content. We deliberately do
		// NOT alias when the user asked for an explicit code (e.g. 'es') but
		// YouTube only had a different track ('bn'): writing the Bengali
		// content under the 'es' key would poison that slot for 30 days and
		// mask any future real Spanish caption from being fetched.
		await setCached(original);
		if (
			requestedLanguage === 'auto' &&
			actualLanguage !== requestedLanguage
		) {
			await setCached(original, requestedLanguage);
		}
	}

	// 2. Decide whether the user wants a language different from what we have.
	//    Skip when target matches source — no point spending an LLM call to
	//    translate Bangla to Bangla.
	const wantsDifferentLanguage =
		translateTo !== null && translateTo !== original.language;

	let displaySegments = original.segments;
	let displayTranscript = original.transcript;
	let displayLanguage = original.language;
	// Tracks whether the response actually carries a translation (vs. real
	// native captions in the target language). Drives `translated_to` and
	// the Original ⇄ Translated toggle payload in the response.
	let actuallyTranslated = false;

	if (wantsDifferentLanguage) {
		// 2a. Translation cache (cheapest path): the same original→target
		//     translation was produced for a prior request. Reuse it for free.
		const cachedTranslation = await getCachedTranslation(
			videoId,
			original.language,
			translateTo!,
		);
		if (cachedTranslation) {
			displaySegments = cachedTranslation.segments;
			displayTranscript = cachedTranslation.transcript;
			displayLanguage = translateTo!;
			actuallyTranslated = true;
		} else {
			// 2b. Before paying for machine translation, see if YouTube actually
			//     has real captions in the target language. Native captions are
			//     always going to be more accurate than translating from another
			//     language — even when YouTube's auto-generated track is rough,
			//     it's transcribed directly from the audio in that language and
			//     beats a cascade of (other language → MT → target).
			const nativeInTarget = await tryNativeInTargetLanguage(
				videoId,
				translateTo!,
				original,
				allowRealWhisper,
			);

			if (nativeInTarget) {
				// Treat the native-target captions as the response's "original" —
				// no translation happened, so the response's original_language,
				// language and translated_to should all reflect that.
				displaySegments = nativeInTarget.payload.segments;
				displayTranscript = nativeInTarget.payload.transcript;
				displayLanguage = nativeInTarget.payload.language;
				original = nativeInTarget.payload;
				actuallyTranslated = false;

				if (!nativeInTarget.fromCache) {
					// Fresh fetch in the target language. Cost is rolled into
					// the single end-of-request deduction; here we just need a
					// pre-flight balance check so we don't burn a Whisper /
					// YouTube call for a 0-credit user.
					if (!didFreshWork) {
						const stateBeforeFetch = await getCreditState(
							input.userId,
						);
						if (stateBeforeFetch.balance < 1) {
							throw new PaymentRequiredError(
								1,
								stateBeforeFetch.balance,
							);
						}
					}
					didFreshWork = true;
				}
			} else {
				// 2c. YouTube doesn't have target-language captions. Fall back
				//     to machine translation (OpenAI → Google, handled inside
				//     translateSegments).
				if (!didFreshWork) {
					const stateBeforeTrans = await getCreditState(input.userId);
					if (stateBeforeTrans.balance < 1) {
						throw new PaymentRequiredError(
							1,
							stateBeforeTrans.balance,
						);
					}
				}

				const translated = await translateSegments(
					original.segments,
					original.language,
					translateTo!,
				);
				displaySegments = translated.segments;
				displayTranscript = translated.fullText;
				displayLanguage = translateTo!;
				actuallyTranslated = true;
				didFreshWork = true;

				// Fire-and-forget: the user already has their translation; we
				// don't want a slow cache write to block the response.
				void setCachedTranslation({
					videoId,
					sourceLanguage: original.language,
					targetLanguage: translateTo!,
					transcript: translated.fullText,
					segments: translated.segments,
					translator: config.OPENAI_API_KEY ? 'openai' : 'google',
					cachedAt: new Date().toISOString(),
				}).catch((err) => {
					logger.warn(
						{
							err,
							videoId,
							from: original.language,
							to: translateTo,
						},
						'Failed to cache translation (non-fatal)',
					);
				});
			}
		}
	}

	// 3. Bill the request. Policy: one HTTP request = at most 1 credit, ever.
	// Multiple internal operations (Whisper for original + Whisper-in-target +
	// MT, or any combination) coalesce into a single deduction. Cache-only
	// paths don't get billed. The deduct is transactional and throws
	// PaymentRequiredError if balance dropped to 0 mid-request (race we let
	// the pre-flight check try to avoid).
	if (didFreshWork) {
		await deductCredits({
			userId: input.userId,
			amount: 1,
			reason: 'transcript_request',
			videoId,
			source: original.source,
			durationSeconds: original.durationSeconds,
			metadata: actuallyTranslated
				? {translated_to: translateTo, from: original.language}
				: undefined,
		});
	}

	// 4. Final balance + format
	const finalState = await getCreditState(input.userId);
	const creditsUsed = didFreshWork ? 1 : 0;

	return formatResponse({
		payload: {
			...original,
			transcript: displayTranscript,
			segments: displaySegments,
		},
		format: input.format,
		// "Cached" means nothing in this request triggered a fresh upstream
		// call: original came from cache AND any target-language work was
		// either skipped or served from cache.
		cached: !didFreshWork,
		creditsUsed,
		creditsRemaining: finalState.balance,
		displayLanguage,
		originalLanguage: original.language,
		// `translated_to` and the toggle payload are only meaningful when we
		// actually machine-translated. When YouTube had real captions in the
		// target language, we treat that as the response's native original.
		translatedTo: actuallyTranslated ? translateTo! : null,
		originalForToggle: actuallyTranslated
			? {transcript: original.transcript, segments: original.segments}
			: null,
	});
}

/**
 * Try to satisfy a "different language wanted" request by sourcing native
 * YouTube captions in the target language, instead of machine-translating
 * from the cached original.
 *
 * Returns the target-language transcript when YouTube has a real track in
 * that language (manual or auto-generated). Returns `null` when no such
 * track exists or YouTube fell back to a different language — the caller
 * should then translate the cached original.
 *
 * `UpstreamBlockedError` is re-thrown so the caller can surface YouTube's
 * bot-challenge / rate-limit state cleanly instead of silently dropping
 * to translation.
 */
async function tryNativeInTargetLanguage(
	videoId: string,
	targetLanguage: string,
	originalForMetadata: CachedTranscript,
	allowRealWhisper: boolean,
): Promise<{payload: CachedTranscript; fromCache: boolean} | null> {
	// Native cache hit on the target language: someone already fetched real
	// captions in this language for this video. Serve them straight.
	const cachedNative = await getCached(videoId, targetLanguage);
	if (cachedNative && cachedNative.language === targetLanguage) {
		return {payload: cachedNative, fromCache: true};
	}

	let result: Awaited<ReturnType<typeof fetchYouTubeCaptions>>;
	try {
		result = await fetchYouTubeCaptions(videoId, targetLanguage);
	} catch (err) {
		if (err instanceof UpstreamBlockedError) throw err;
		logger.info(
			{err, videoId, target: targetLanguage},
			'No YouTube captions in target language; trying Whisper before translation',
		);
		// Whisper is one rung above translation: if the audio itself is in
		// the target language, Whisper produces a real native transcript
		// rather than a machine-translated one. The `language` arg is a hint
		// — Whisper still detects the spoken language, so we strict-match
		// against `targetLanguage` afterwards. Mismatch (audio was in some
		// other language) ⇒ return null, caller falls to translation.
		return await tryWhisperInTargetLanguage(
			videoId,
			targetLanguage,
			originalForMetadata,
			allowRealWhisper,
		);
	}

	// `fetchYouTubeCaptions` falls back to "best alternative track" when the
	// requested language doesn't exist. We can only count it as a native hit
	// when the served track actually matches the language the user asked for.
	if (result.language !== targetLanguage) {
		logger.info(
			{videoId, target: targetLanguage, served: result.language},
			'YouTube has no track in target language; trying Whisper before translation',
		);
		return await tryWhisperInTargetLanguage(
			videoId,
			targetLanguage,
			originalForMetadata,
			allowRealWhisper,
		);
	}

	const payload: CachedTranscript = {
		videoId,
		language: result.language,
		title: originalForMetadata.title,
		channel: originalForMetadata.channel,
		durationSeconds: result.durationSeconds,
		source: 'native_captions',
		transcript: segmentsToPlainText(result.segments),
		segments: result.segments,
		cachedAt: new Date().toISOString(),
	};
	await setCached(payload);
	return {payload, fromCache: false};
}

/**
 * Last chance to satisfy a target-language request without falling back to
 * machine translation: ask Whisper to transcribe the audio. Useful when the
 * video's spoken audio is in the requested language but YouTube didn't
 * expose captions for it.
 *
 * Strict language match required — Whisper's `language` parameter is a hint,
 * not a translation target. If the audio is in English and the user asked
 * for Spanish, Whisper will likely return English text and `language: 'en'`;
 * we reject that here and let the caller machine-translate from the cached
 * original instead.
 */
async function tryWhisperInTargetLanguage(
	videoId: string,
	targetLanguage: string,
	originalForMetadata: CachedTranscript,
	allowRealWhisper: boolean,
): Promise<{payload: CachedTranscript; fromCache: boolean} | null> {
	if (!allowRealWhisper) {
		// Free-plan caller — we won't spend OpenAI quota on them. Returning
		// null falls through to machine translation of the cached original,
		// which is the right behavior: the user already paid (in credits) for
		// the original native-captions fetch and can still get the target
		// language via the translator tier.
		logger.info(
			{videoId, target: targetLanguage},
			'Skipping Whisper-in-target: caller is not Whisper-eligible; falling back to translation',
		);
		return null;
	}
	let whisper: Awaited<ReturnType<typeof transcribeWithWhisper>>;
	try {
		whisper = await transcribeWithWhisper(videoId, targetLanguage, {
			allowRealWhisper,
		});
	} catch (err) {
		logger.info(
			{err, videoId, target: targetLanguage},
			'Whisper failed for target language; will fall back to translation',
		);
		return null;
	}

	if (whisper.language !== targetLanguage) {
		logger.info(
			{videoId, target: targetLanguage, whisperLang: whisper.language},
			'Whisper detected a different language than target; will fall back to translation',
		);
		return null;
	}

	const payload: CachedTranscript = {
		videoId,
		language: whisper.language,
		title: originalForMetadata.title,
		channel: originalForMetadata.channel,
		durationSeconds: whisper.durationSeconds,
		source: 'whisper',
		transcript: segmentsToPlainText(whisper.segments),
		segments: whisper.segments,
		cachedAt: new Date().toISOString(),
	};
	await setCached(payload);
	return {payload, fromCache: false};
}

async function fetchTranscript(
	videoId: string,
	language: string,
	nativeOnly: boolean,
	allowRealWhisper: boolean,
) {
	const whisperOpts = {allowRealWhisper};
	try {
		return await fetchYouTubeCaptions(videoId, language);
	} catch (err) {
		logger.info(
			{err, videoId, language, nativeOnly, allowRealWhisper},
			'Failed to fetch YouTube captions',
		);
		if (err instanceof NoTranscriptError) {
			if (nativeOnly) {
				// Caller asked us not to spend Whisper credits; surface the failure.
				throw err;
			}
			logger.info(
				{allowRealWhisper},
				`is user paid:${allowRealWhisper}'`,
			);
			if (!allowRealWhisper) {
				// Free-plan user, no native captions to serve them, and we can't
				// fall through to Whisper on their behalf. Throw a 402 that names
				// both halves — *why* we couldn't serve the request and *what*
				// the user needs to do — instead of silently calling Whisper and
				// having it reject with a generic upgrade-required.
				logger.info(
					{videoId},
					'No native captions and caller is not Whisper-eligible; surfacing UPGRADE_REQUIRED',
				);
				throw new UpgradeRequiredError(
					'AI transcription',
					'No native captions are available for this video.',
				);
			}
			logger.info(
				{videoId},
				'No native captions; falling back to Whisper',
			);
			const response = await transcribeWithWhisper(
				videoId,
				language,
				whisperOpts,
			);
			logger.info({response}, `response:${JSON.stringify(response)}'`);
			return response;
		}
		// YouTube is refusing to serve our IP — either an HTTP 429 from their
		// edge or the "Sign in to confirm you're not a bot" challenge that
		// fires for shared datacenter ranges (Render et al.). We used to fall
		// back to Whisper here on the theory that yt-dlp's audio path hit
		// different YouTube endpoints, but that's no longer true: in practice
		// both paths share egress and both hit the same wall, so falling back
		// just burns ~30s of yt-dlp time before failing anyway. Surface
		// immediately so the user can retry once the operator rotates
		// PROXY_URL / YT_COOKIES_PATH.

		if (err instanceof UpstreamBlockedError) {
			logger.warn(
				{videoId, allowRealWhisper},
				'YouTube is blocking our IP; surfacing 503',
			);
			throw err;
		}
		if (err instanceof ApiError) throw err;
		// Unknown error inside the YouTube layer: treat as Whisper-eligible to
		// maximize success unless the caller explicitly opted out or the user
		// isn't on a paid plan (in which case Whisper isn't an option anyway).
		if (nativeOnly || !allowRealWhisper) {
			logger.warn(
				{err, videoId, nativeOnly, allowRealWhisper},
				'YouTube fetch failed and Whisper fallback unavailable; surfacing original error',
			);
			throw err;
		}
		logger.warn(
			{err, videoId, allowRealWhisper},
			'YouTube fetch failed unexpectedly; trying Whisper',
		);
		return await transcribeWithWhisper(videoId, language, whisperOpts);
	}
}

interface FormatResponseOptions {
	/**
	 * The cached payload whose `segments`/`transcript` already reflect the
	 * text the user should see (translated if we translated, original
	 * otherwise). `payload.language` may differ from `displayLanguage` —
	 * we trust `displayLanguage` as the source of truth for what the user is
	 * looking at.
	 */
	payload: CachedTranscript;
	format: OutputFormat;
	cached: boolean;
	creditsUsed: number;
	creditsRemaining: number;
	/** Language code of the text in `payload.transcript` / `payload.segments`. */
	displayLanguage: string;
	/** What YouTube/Whisper produced before any translation step. */
	originalLanguage: string;
	/** Set when a translation was applied; null otherwise. */
	translatedTo: string | null;
	/**
	 * When translation was applied, this carries the UNtranslated transcript
	 * + segments so the JSON response can ship both for instant Original ⇄
	 * Translated toggling in the viewer. Null when no translation happened.
	 */
	originalForToggle: {transcript: string; segments: Segment[]} | null;
}

function formatResponse(opts: FormatResponseOptions): TranscriptResponse {
	const {payload, format} = opts;
	const base = {
		video_id: payload.videoId,
		url: buildWatchUrl(payload.videoId),
		title: payload.title,
		channel: payload.channel,
		duration: payload.durationSeconds,
		language: opts.displayLanguage,
		original_language: opts.originalLanguage,
		translated_to: opts.translatedTo,
		source: payload.source,
		format,
		credits_used: opts.creditsUsed,
		credits_remaining: opts.creditsRemaining,
		cached: opts.cached,
		fetched_at: payload.cachedAt,
	};

	switch (format) {
		case 'json':
			return {
				...base,
				transcript: payload.transcript,
				segments: payload.segments,
				// Only meaningful in JSON mode — non-JSON formats deliver a single
				// string body, so the viewer-only toggle data has nowhere to live.
				original_transcript: opts.originalForToggle?.transcript,
				original_segments: opts.originalForToggle?.segments,
			};
		case 'text':
			return {...base, transcript: payload.transcript};
		case 'text-timestamps':
			return {
				...base,
				transcript: segmentsToTextWithTimestamps(payload.segments),
			};
		case 'srt':
			return {...base, transcript: segmentsToSrt(payload.segments)};
		case 'vtt':
			return {...base, transcript: segmentsToVtt(payload.segments)};
		default:
			// Should be impossible — schema validates upstream
			throw new ValidationError(`Unsupported format: ${format}`);
	}
}

// ---------------------------------------------------------------------------
// Bulk transcripts — used by the playlist / channel bulk routes.
//
// Loops `getTranscript()` over a list of videos with bounded concurrency.
// Each underlying call is independently transactional and deducts 0 (cache
// hit) or 1 (fresh) credit, so the bulk service does NOT call `deductCredits`
// itself — it just aggregates results and the totals.
//
// Per-item errors are captured into the result entries; the loop continues
// past anything recoverable (NoTranscriptError, UpgradeRequiredError,
// VideoNotFoundError, …). Two error classes abort the remaining unprocessed
// videos:
//   - PaymentRequiredError: out of credits — every subsequent call would
//     fail at the deduct step, just wasting YouTube quota.
//   - UpstreamBlockedError: YouTube is refusing our IP — proxy/cookie issue
//     is global and won't fix itself within a single request.
// Items that never got attempted are marked failed with the abort reason so
// the response is consistently shaped (one entry per input video).
// ---------------------------------------------------------------------------

const BULK_CONCURRENCY = 5;

export interface BulkVideoInput {
	url: string;
	video_id?: string | null;
	title?: string | null;
	channel?: string | null;
	thumbnail_url?: string | null;
	duration_text?: string | null;
}

export interface BulkTranscriptOptions {
	userId: string;
	videos: BulkVideoInput[];
	format: OutputFormat;
	language?: string;
	nativeOnly?: boolean;
	translateTo?: string;
}

export interface BulkTranscriptError {
	code: string;
	message: string;
}

export interface BulkTranscriptItem {
	url: string;
	video_id: string | null;
	title: string | null;
	channel: string | null;
	thumbnail_url: string | null;
	duration_text: string | null;
	ok: boolean;
	/** Present when ok === true. */
	transcript?: TranscriptResponse;
	/** Present when ok === false. */
	error?: BulkTranscriptError;
}

export interface BulkTranscriptResult {
	items: BulkTranscriptItem[];
	total: number;
	succeeded: number;
	failed: number;
	/** Total credits deducted across this bulk run (sum of per-item credits). */
	credits_used: number;
}

export async function runBulkTranscripts(
	opts: BulkTranscriptOptions,
): Promise<BulkTranscriptResult> {
	const items: Array<BulkTranscriptItem | null> = opts.videos.map(() => null);
	let abortError: BulkTranscriptError | null = null;

	async function processOne(index: number): Promise<void> {
		// If another worker already aborted the run, fill in the slot and skip.
		if (abortError) {
			items[index] = makeFailureItem(opts.videos[index], abortError);
			return;
		}
		const v = opts.videos[index];
		try {
			const transcript = await getTranscript({
				userId: opts.userId,
				url: v.url,
				format: opts.format,
				language: opts.language,
				nativeOnly: opts.nativeOnly,
				translateTo: opts.translateTo,
			});
			items[index] = {
				url: v.url,
				video_id: transcript.video_id,
				title: v.title ?? transcript.title ?? null,
				channel: v.channel ?? transcript.channel ?? null,
				thumbnail_url: v.thumbnail_url ?? null,
				duration_text: v.duration_text ?? null,
				ok: true,
				transcript,
			};
		} catch (err) {
			const apiErr = toBulkError(err);
			items[index] = makeFailureItem(v, apiErr);
			// Two errors poison the rest of the batch — capture so other
			// workers / subsequent chunks short-circuit.
			if (
				err instanceof PaymentRequiredError ||
				err instanceof UpstreamBlockedError
			) {
				abortError = apiErr;
				logger.warn(
					{err, code: apiErr.code, index, total: opts.videos.length},
					'Bulk transcripts: fatal error, aborting remaining videos',
				);
			}
		}
	}

	// Bounded-concurrency loop: process up to BULK_CONCURRENCY videos at a
	// time. We don't use a worker-pool lib — chunked Promise.allSettled is
	// good enough at this scale (limit cap is 20 in the route) and keeps
	// dependencies minimal. `allSettled` so one rejection doesn't kill the
	// chunk — we already swallow inside processOne, but it's defense in depth.
	for (let i = 0; i < opts.videos.length; i += BULK_CONCURRENCY) {
		const chunk: number[] = [];
		for (
			let j = i;
			j < Math.min(i + BULK_CONCURRENCY, opts.videos.length);
			j++
		) {
			chunk.push(j);
		}
		await Promise.allSettled(chunk.map((idx) => processOne(idx)));
		if (abortError) {
			// Fill any remaining slots without making more upstream calls.
			for (let k = i + BULK_CONCURRENCY; k < opts.videos.length; k++) {
				items[k] = makeFailureItem(opts.videos[k], abortError);
			}
			break;
		}
	}

	const finalItems = items.map(
		(it, idx) =>
			it ??
			makeFailureItem(opts.videos[idx], {
				code: 'INTERNAL_ERROR',
				message: 'Item was not processed',
			}),
	);
	const succeeded = finalItems.filter((i) => i.ok).length;
	const credits_used = finalItems.reduce(
		(sum, i) => sum + (i.ok ? (i.transcript?.credits_used ?? 0) : 0),
		0,
	);

	return {
		items: finalItems,
		total: finalItems.length,
		succeeded,
		failed: finalItems.length - succeeded,
		credits_used,
	};
}

function makeFailureItem(
	v: BulkVideoInput,
	error: BulkTranscriptError,
): BulkTranscriptItem {
	let extractedId: string | null = v.video_id ?? null;
	if (!extractedId) {
		try {
			extractedId = extractVideoId(v.url);
		} catch {
			extractedId = null;
		}
	}
	return {
		url: v.url,
		video_id: extractedId,
		title: v.title ?? null,
		channel: v.channel ?? null,
		thumbnail_url: v.thumbnail_url ?? null,
		duration_text: v.duration_text ?? null,
		ok: false,
		error,
	};
}

function toBulkError(err: unknown): BulkTranscriptError {
	if (err instanceof ApiError) {
		return {code: err.code, message: err.message};
	}
	if (err instanceof Error) {
		return {code: 'INTERNAL_ERROR', message: err.message};
	}
	return {code: 'INTERNAL_ERROR', message: 'Unknown error'};
}
