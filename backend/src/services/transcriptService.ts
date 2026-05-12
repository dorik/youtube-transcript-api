import {extractVideoId, buildWatchUrl} from '../utils/youtubeUrl';
import {fetchYouTubeCaptions, fetchYouTubeMetadata} from './youtubeService';
import {transcribeWithWhisper, whisperCreditCost} from './whisperService';
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
	UpstreamBlockedError,
	ValidationError,
} from '../utils/errors';
import {logger} from '../config/logger';
import {config} from '../config/env';

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
	/** True when we had to use the stub translator (no real OpenAI call). */
	translation_stubbed?: boolean;
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
 *     and (if the translator was real, not the stub) write the result
 *     back to the cache so the next caller skips both.
 *  4. Format the response (JSON / text / SRT / VTT / text-timestamps).
 */
export async function getTranscript(
	input: GetTranscriptInput,
): Promise<TranscriptResponse> {
	const videoId = extractVideoId(input.url);
	// 'auto' is our marker for "let YouTube pick whatever track is available".
	// Previously this defaulted to 'en', which silently broke any video that
	// didn't have an English caption track (e.g. a Bangla news video).
	const requestedLanguage =
		input.language && input.language.trim() && input.language !== 'auto'
			? input.language
			: 'auto';

	// Normalize translation target. 'none' / undefined / empty all mean "no
	// translation"; we'll also skip translation if the target equals the
	// original language we end up with.
	const translateTo =
		input.translateTo &&
		input.translateTo.trim() &&
		input.translateTo !== 'none' &&
		input.translateTo !== 'auto'
			? input.translateTo.trim()
			: null;

	// 1. Cache check for the ORIGINAL transcript. The user's request key is
	//    used directly; explicit-language requests are served from a
	//    per-language alias written after a fresh fetch.
	let original: CachedTranscript;
	let originalCacheHit = false;
	let creditsForOriginal = 0;

	const cached = await getCached(videoId, requestedLanguage);
	if (cached) {
		original = cached;
		originalCacheHit = true;
	} else {
		// Pre-flight credit check (ballpark: 1 credit). Whisper re-checks based
		// on duration — credit deduction itself is transactional and throws if
		// the user can't afford it.
		const stateBefore = await getCreditState(input.userId);
		if (stateBefore.balance < 1) {
			throw new PaymentRequiredError(1, stateBefore.balance);
		}

		// Real OpenAI Whisper is a paid-only feature. Free users get the stub
		// response instead so we don't burn OpenAI quota on accounts that
		// haven't paid. Look up the plan once here and pipe the boolean down.
		const subscription = await getUserSubscription(input.userId);
		const allowRealWhisper = isPaidPlan(subscription?.plan_id);

		const fetched = await fetchTranscript(
			videoId,
			requestedLanguage,
			input.nativeOnly ?? false,
			allowRealWhisper,
		);
		const metadata = await fetchYouTubeMetadata(videoId);

		creditsForOriginal =
			fetched.source === 'whisper'
				? whisperCreditCost(fetched.durationSeconds)
				: 1;

		await deductCredits({
			userId: input.userId,
			amount: creditsForOriginal,
			reason: 'transcript_fetch',
			videoId,
			source: fetched.source,
			durationSeconds: fetched.durationSeconds,
		});

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

		// Cache under the actual language; alias under the requested key when
		// they differ so future 'auto' AND explicit lookups both hit.
		await setCached(original);
		if (requestedLanguage !== actualLanguage) {
			await setCached(original, requestedLanguage);
		}
	}

	// 2. Decide whether to translate. Skip when target matches source — no
	//    point spending an LLM call to translate Bangla to Bangla.
	const shouldTranslate =
		translateTo !== null && translateTo !== original.language;

	let displaySegments = original.segments;
	let displayTranscript = original.transcript;
	let displayLanguage = original.language;
	let translationStubbed: boolean | undefined;
	let creditsForTranslation = 0;
	let translationCacheHit = false;

	if (shouldTranslate) {
		// Cache check first. Hit → no upstream call, no credit deduction — the
		// user already paid for this translation the first time around and the
		// text doesn't change. Miss falls through to the upstream + charge
		// path below.
		const cachedTranslation = await getCachedTranslation(
			videoId,
			original.language,
			translateTo!,
		);
		if (cachedTranslation) {
			displaySegments = cachedTranslation.segments;
			displayTranscript = cachedTranslation.transcript;
			displayLanguage = translateTo!;
			// Cached output is necessarily a real (non-stubbed) translation:
			// stubs are deliberately not written to the cache.
			translationStubbed = false;
			translationCacheHit = true;
		} else {
			// Pre-flight credit check, then translate, then charge +1 credit in
			// its own transactional deduction so the user sees an accurate
			// breakdown later.
			const stateBeforeTrans = await getCreditState(input.userId);
			if (stateBeforeTrans.balance < 1) {
				throw new PaymentRequiredError(1, stateBeforeTrans.balance);
			}

			const translated = await translateSegments(
				original.segments,
				original.language,
				translateTo!,
			);
			displaySegments = translated.segments;
			displayTranscript = translated.fullText;
			displayLanguage = translateTo!;
			translationStubbed = !translated.real;

			await deductCredits({
				userId: input.userId,
				amount: 1,
				reason: 'transcript_translation',
				videoId,
				source: original.source,
				metadata: {from: original.language, to: translateTo},
			});
			creditsForTranslation = 1;

			// Only cache real translations. Stubbed output contains the
			// `[src→tgt]` placeholder prefix and is intentionally low-quality;
			// caching it would poison the table for 30 days even after
			// STUB_TRANSLATION is turned off.
			if (translated.real) {
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

	// 3. Final balance + format
	const finalState = await getCreditState(input.userId);
	const totalCreditsUsed = creditsForOriginal + creditsForTranslation;

	return formatResponse({
		payload: {
			...original,
			transcript: displayTranscript,
			segments: displaySegments,
		},
		format: input.format,
		// True when this whole request was served without an upstream call:
		// - original came from cache, and
		// - either no translation was needed, or the translation came from cache too.
		cached: originalCacheHit && (!shouldTranslate || translationCacheHit),
		creditsUsed: totalCreditsUsed,
		creditsRemaining: finalState.balance,
		displayLanguage,
		originalLanguage: original.language,
		translatedTo: shouldTranslate ? translateTo! : null,
		translationStubbed,
		// When we translated, also include the untranslated content so the
		// dashboard viewer can offer an instant Original ⇄ Translated toggle.
		originalForToggle: shouldTranslate
			? {transcript: original.transcript, segments: original.segments}
			: null,
	});
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
			'Failed billal to fetch YouTube captions',
		);
		if (err instanceof NoTranscriptError) {
			if (nativeOnly) {
				// Caller asked us not to spend Whisper credits; surface the failure.
				throw err;
			}
			logger.info(
				{videoId, allowRealWhisper},
				'No native captions; falling back to Whisper',
			);
			return await transcribeWithWhisper(videoId, language, whisperOpts);
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
		// maximize success unless the caller explicitly opted out.
		if (nativeOnly) {
			logger.warn(
				{err, videoId},
				'YouTube fetch failed and native_only=true; not falling back',
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
	/** Set when the translator fell back to the stub (no real OpenAI call). */
	translationStubbed?: boolean;
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
		translation_stubbed: opts.translationStubbed,
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
