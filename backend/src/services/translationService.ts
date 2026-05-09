import OpenAI from 'openai';
// `google-translate-api-x` ships as ESM but Node CJS handles its default
// export through interop. We import via require to avoid wrestling with TS
// ESM-in-CJS settings — it's a single function call.
import gtx from 'google-translate-api-x';
import { config } from '../config/env';
import { logger } from '../config/logger';
import type { Segment } from './formatters';

/**
 * Translate transcript segments to a target language while preserving the
 * timing structure (start + duration).
 *
 * Three modes, picked at request time:
 *
 *  1. STUB (`STUB_TRANSLATION=true`) — prefix each segment with `[src→tgt]`
 *     and return as-is. No external calls. Cheapest dev path; obviously not
 *     a real translation.
 *  2. OpenAI (`STUB_TRANSLATION=false` AND `OPENAI_API_KEY` set) — single
 *     batched JSON call to gpt-4o-mini. High quality, costs real money.
 *  3. Google Translate (`STUB_TRANSLATION=false` AND no OpenAI key) — uses
 *     the unofficial `google-translate-api-x` library. Free, no key
 *     required, decent quality. This is the default zero-config path: flip
 *     the stub flag and translation Just Works.
 *
 * On any real-mode failure we fall back to the stub instead of erroring, so
 * the user still gets a usable response and we surface
 * `translation_stubbed: true` on the API envelope.
 */

const TRANSLATION_LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic',
  bn: 'Bengali',
  bg: 'Bulgarian',
  zh: 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  hr: 'Croatian',
  cs: 'Czech',
  da: 'Danish',
  nl: 'Dutch',
  en: 'English',
  et: 'Estonian',
  fi: 'Finnish',
  fr: 'French',
  de: 'German',
  el: 'Greek',
  he: 'Hebrew',
  hi: 'Hindi',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  lv: 'Latvian',
  lt: 'Lithuanian',
  ms: 'Malay',
  no: 'Norwegian',
  fa: 'Persian',
  pl: 'Polish',
  pt: 'Portuguese',
  'pt-BR': 'Brazilian Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sr: 'Serbian',
  sk: 'Slovak',
  sl: 'Slovenian',
  es: 'Spanish',
  sw: 'Swahili',
  sv: 'Swedish',
  tl: 'Tagalog',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
};

export function languageName(code: string | undefined | null): string {
  if (!code) return 'Unknown';
  return TRANSLATION_LANGUAGE_NAMES[code] ?? code;
}

export interface TranslateResult {
  segments: Segment[];
  /** Full text joined from translated segments, for the `transcript` field. */
  fullText: string;
  /** True when we used real OpenAI; false when the stub ran. */
  real: boolean;
}

export async function translateSegments(
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
): Promise<TranslateResult> {
  if (segments.length === 0) {
    return { segments: [], fullText: '', real: false };
  }
  if (sourceLang === targetLang) {
    // No-op: caller should usually skip this entirely, but handle defensively.
    return {
      segments,
      fullText: segments.map((s) => s.text).join(' '),
      real: false,
    };
  }

  if (config.STUB_TRANSLATION) {
    return stubTranslate(segments, sourceLang, targetLang);
  }

  // Real mode. Prefer OpenAI when a key is available, otherwise use the
  // free Google Translate fallback.
  const useOpenAI = !!config.OPENAI_API_KEY;
  try {
    return useOpenAI
      ? await openAITranslate(segments, sourceLang, targetLang)
      : await googleTranslate(segments, sourceLang, targetLang);
  } catch (err) {
    logger.error(
      { err, sourceLang, targetLang, segmentCount: segments.length, useOpenAI },
      'Primary translator failed; trying alternate / stub',
    );
    // If OpenAI was first choice and broke, try Google as a secondary path
    // before giving up. If we were already on Google, stub.
    if (useOpenAI) {
      try {
        return await googleTranslate(segments, sourceLang, targetLang);
      } catch (err2) {
        logger.error(
          { err: err2, sourceLang, targetLang },
          'Google Translate fallback also failed; using stub',
        );
      }
    }
    return stubTranslate(segments, sourceLang, targetLang);
  }
}

function stubTranslate(
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
): TranslateResult {
  const prefix = `[${sourceLang}→${targetLang}]`;
  const translated = segments.map((s) => ({ ...s, text: `${prefix} ${s.text}` }));
  return {
    segments: translated,
    fullText: translated.map((s) => s.text).join(' '),
    real: false,
  };
}

let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return openai;
}

async function openAITranslate(
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
): Promise<TranslateResult> {
  const client = getOpenAI();

  // Build a numbered list so the LLM has unambiguous indices to map back to.
  // We send all segments in one request — gpt-4o-mini's context window is
  // huge and one round-trip beats N small ones for both cost and latency.
  const numbered = segments
    .map((s, i) => `${i + 1}. ${s.text}`)
    .join('\n');

  const sourceName = languageName(sourceLang);
  const targetName = languageName(targetLang);

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          `You translate YouTube transcripts. The user gives you a numbered list of lines in ${sourceName}. ` +
          `Translate each line to ${targetName}, preserving meaning and tone. ` +
          'Return JSON ONLY in this exact shape: {"translations": ["...", "...", ...]} ' +
          'with one entry per input line, in the same order. Do not merge or split lines. ' +
          'Do not include the number prefixes in the output strings.',
      },
      { role: 'user', content: numbered },
    ],
  });

  const content = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content) as { translations?: unknown };
  const out = parsed.translations;

  if (!Array.isArray(out) || out.length !== segments.length) {
    throw new Error(
      `Translation length mismatch: expected ${segments.length}, got ${
        Array.isArray(out) ? out.length : 'non-array'
      }`,
    );
  }

  const translated: Segment[] = segments.map((s, i) => ({
    start: s.start,
    duration: s.duration,
    text: typeof out[i] === 'string' ? (out[i] as string).trim() : s.text,
  }));

  return {
    segments: translated,
    fullText: translated.map((s) => s.text).join(' '),
    real: true,
  };
}

/**
 * Free fallback using `google-translate-api-x`. Sends all segment texts in
 * a single batch (the library accepts string[] and returns string[] in the
 * same order). No API key required; rate-limited but fine for MVP volume.
 *
 * Some Google language codes differ from our internal codes (e.g. our
 * `zh-TW` vs Google's `zh-tw`). The library is case-insensitive for
 * common codes, but we normalize anyway.
 */
async function googleTranslate(
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
): Promise<TranslateResult> {
  const from = normalizeForGoogle(sourceLang) ?? 'auto';
  const to = normalizeForGoogle(targetLang) ?? targetLang;

  const texts = segments.map((s) => s.text);
  // The library accepts either a single string or string[]. With an array
  // it returns an array of result objects with `.text`. The default batch
  // mode rejects the entire request on a single segment failure — pass
  // `rejectOnPartialFail: false` so individual misses become `null` and we
  // can fall back to the original text for those. Cast through unknown
  // because the package's type definitions don't perfectly model the
  // array overload.
  type GtxResult = { text: string | null };
  type GtxFn = (
    input: string[],
    opts: { from: string; to: string; rejectOnPartialFail?: boolean },
  ) => Promise<GtxResult[] | GtxResult>;
  const raw = (await (gtx as unknown as GtxFn)(texts, {
    from,
    to,
    rejectOnPartialFail: false,
  })) as GtxResult[] | GtxResult;
  const results: GtxResult[] = Array.isArray(raw) ? raw : [raw];

  if (results.length !== segments.length) {
    throw new Error(
      `Google Translate length mismatch: expected ${segments.length}, got ${results.length}`,
    );
  }

  const translated: Segment[] = segments.map((s, i) => {
    const out = results[i]?.text;
    return {
      start: s.start,
      duration: s.duration,
      // Per-segment fallback: if Google nulled this one, keep the original
      // text rather than dropping the line.
      text: typeof out === 'string' && out.trim() ? out.trim() : s.text,
    };
  });

  return {
    segments: translated,
    fullText: translated.map((s) => s.text).join(' '),
    real: true,
  };
}

function normalizeForGoogle(code: string | undefined): string | undefined {
  if (!code) return undefined;
  // Google uses lowercase, hyphenated regional variants. 'auto' is also valid.
  if (code === 'auto') return 'auto';
  return code.toLowerCase();
}
