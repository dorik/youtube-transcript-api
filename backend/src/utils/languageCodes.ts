/**
 * Single canonical form for language identifiers in the transcript pipeline.
 *
 * Why this exists: the data crosses several formats.
 *   - User input (`?language=en`):     ISO 639-1 codes, sometimes mis-cased
 *                                       or full names like `english`.
 *   - YouTube caption tracks:          ISO codes, plus region-tagged variants
 *                                       (`en-US`, `pt-BR`), the original-track
 *                                       marker (`en-orig`), and auto-track
 *                                       variants (`en-auto`).
 *   - Whisper `verbose_json.language`: lowercase English NAMES — `english`,
 *                                       `bengali`, `spanish`. (Whisper takes a
 *                                       code as input but returns a name on
 *                                       output.)
 *   - Frontend dropdowns / cache keys / translation service / DB columns:
 *                                       ISO 639-1 codes.
 *
 * Without one normalization step, `wantsDifferentLanguage = translateTo !==
 * original.language` flips to `true` every time Whisper runs (`"bn" !==
 * "bengali"`), and the pipeline falls into the translate-from-original
 * branch even when Whisper already produced the requested language.
 *
 * Keep the list of supported codes in sync with
 * `frontend/src/lib/languages.ts`. The Whisper-name map covers the
 * superset of languages Whisper recognizes, narrowed to ours.
 */

const SUPPORTED_CODES = new Set<string>([
  'ar', 'bn', 'bg', 'zh', 'zh-TW', 'hr', 'cs', 'da', 'nl', 'en',
  'et', 'fi', 'fr', 'de', 'el', 'he', 'hi', 'hu', 'id', 'it',
  'ja', 'ko', 'lv', 'lt', 'ms', 'no', 'fa', 'pl', 'pt', 'pt-BR',
  'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sw', 'sv', 'tl', 'ta',
  'te', 'th', 'tr', 'uk', 'ur', 'vi',
]);

/**
 * Whisper returns the detected language as a lowercase English NAME despite
 * accepting an ISO code on input — documented quirk of the OpenAI Audio API.
 *
 * Whisper does not distinguish `zh-TW` from `zh` or `pt-BR` from `pt` on
 * output. The base code is the safe default; region-tagged variants only
 * appear when YouTube serves a track tagged that way explicitly.
 */
const WHISPER_NAME_TO_CODE: Record<string, string> = {
  arabic: 'ar',
  bengali: 'bn',
  bulgarian: 'bg',
  chinese: 'zh',
  croatian: 'hr',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  estonian: 'et',
  finnish: 'fi',
  french: 'fr',
  german: 'de',
  greek: 'el',
  hebrew: 'he',
  hindi: 'hi',
  hungarian: 'hu',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  latvian: 'lv',
  lithuanian: 'lt',
  malay: 'ms',
  norwegian: 'no',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  romanian: 'ro',
  russian: 'ru',
  serbian: 'sr',
  slovak: 'sk',
  slovenian: 'sl',
  spanish: 'es',
  swahili: 'sw',
  swedish: 'sv',
  tagalog: 'tl',
  tamil: 'ta',
  telugu: 'te',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  urdu: 'ur',
  vietnamese: 'vi',
};

/**
 * Canonicalize a language identifier to an ISO 639-1 code.
 *
 *   "english"   → "en"
 *   "EN"        → "en"
 *   "en-orig"   → "en"        // YouTube original-track marker
 *   "en-auto"   → "en"        // YouTube auto-generated marker
 *   "zh-tw"     → "zh-TW"     // region tag re-cased
 *   "en"        → "en"
 *   ""          → ""
 *   undefined   → ""
 *   "klingon"   → "klingon"   // unknown input flows through, lowercased,
 *                                 so two unknowns of the same name still
 *                                 compare equal.
 *
 * Sentinels (`auto`, `none`) are returned as-is so the orchestrator can
 * still distinguish them from real language codes.
 */
export function normalizeLanguageCode(
  input: string | null | undefined,
): string {
  if (!input) return '';
  const raw = input.trim();
  if (!raw) return '';

  // Sentinels used by the request parsing layer — leave untouched.
  if (raw === 'auto' || raw === 'none') return raw;

  // Already canonical (preserves region tags like zh-TW exactly).
  if (SUPPORTED_CODES.has(raw)) return raw;

  // YouTube suffixes: en-orig, en-auto.
  const stripped = raw.replace(/-(orig|auto)$/i, '');
  if (SUPPORTED_CODES.has(stripped)) return stripped;

  const lower = raw.toLowerCase();

  // Whisper-style full name.
  if (WHISPER_NAME_TO_CODE[lower]) return WHISPER_NAME_TO_CODE[lower];

  // Mis-cased region tag: "ZH-TW", "pt-br" → "zh-TW", "pt-BR".
  if (raw.includes('-')) {
    const [base, region] = raw.split('-');
    const recased = `${base.toLowerCase()}-${(region ?? '').toUpperCase()}`;
    if (SUPPORTED_CODES.has(recased)) return recased;
    // Strip region entirely as a last try (so "en-US" → "en" when "en-US"
    // isn't in our supported set but "en" is).
    if (SUPPORTED_CODES.has(base.toLowerCase())) return base.toLowerCase();
  }

  // Unknown — flow through, lowercased, so identical unknowns still
  // compare equal and stay visible in logs.
  return lower;
}
