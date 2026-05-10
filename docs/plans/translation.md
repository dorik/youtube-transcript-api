# Translation

## What this is

Customers want transcripts in a language they can actually read. A Bengali tutorial channel has English-speaking customers; a French news clip is needed in Spanish for an analyst's brief; an indie podcaster wants Japanese subtitles for export. Translation turns the YouTube Transcripts API from an English-leaning utility into a genuinely global product, and it is exposed as a single optional `?translate_to=<lang>` query parameter on the public endpoint.

The mechanism is a three-tier translator chosen at request time based on environment configuration. There is a stub tier for development that prefixes each segment with a tag like `[en→es]` so the code path is exercised without spending money or hitting rate limits. There is an OpenAI tier that uses `gpt-4o-mini` with batched JSON I/O when an `OPENAI_API_KEY` is configured — this is our preferred real-mode translator because the quality is best and the cost is reasonable. And there is a free `google-translate-api-x` tier that requires no key and works out of the box, used as the default real-mode translator when no OpenAI key is present and as a fallback if OpenAI fails.

Translation is not free for the customer — it adds a one-credit surcharge on top of whatever the base transcript cost was. A cached native English transcript translated to Spanish costs 0 (cache hit) + 1 (translation) = 1 credit. A fresh Whisper run on a 12-minute video translated to French costs 12 + 1 = 13. The surcharge is flat regardless of segment count because in practice the cost difference between translating a 30-second clip and a 30-minute video is small enough that a flat per-request fee is simpler and more predictable.

Translations themselves are not cached in this MVP. Every translation request hits the live translator. This is a deliberate scope cut — caching translations adds a third dimension (`videoId`, `language`, `targetLanguage`) to the cache key space and a non-trivial amount of storage, and we'd rather see how customers actually use translation before committing to a caching design. It is called out as future work below.

## Backend

### Schema

No new tables are required for translation. The list of supported language codes lives in a TypeScript constant on the backend (used for validation) and an identical constant in the Next.js codebase (used for the picker dropdown), kept in sync by convention — both files reference the same documented list of ~45 ISO 639-1 codes. If the lists ever drift, the backend rejects an unknown code with a 400 and the frontend dropdown silently doesn't include it; this is acceptable because the source of truth is the backend and the frontend just won't offer something the API would reject anyway.

The supported language list covers the major globally-spoken languages and a long tail of common European, Asian, and Middle Eastern languages: English, Spanish, French, German, Italian, Portuguese, Dutch, Polish, Russian, Ukrainian, Turkish, Arabic, Hebrew, Persian, Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Punjabi, Urdu, Chinese (Simplified and Traditional), Japanese, Korean, Vietnamese, Thai, Indonesian, Malay, Filipino, Swahili, Amharic, Yoruba, Zulu, Greek, Czech, Hungarian, Romanian, Bulgarian, Serbian, Croatian, Slovak, Slovenian, Lithuanian, Latvian, Estonian, Finnish, Swedish, Norwegian, Danish, Icelandic. The exact list will likely shift slightly as we calibrate but ~45 is the target.

### Endpoints

No new endpoints. Translation is a query parameter on `GET /v1/transcript`:
- `translate_to=<isoCode>` — when present, the transcript's segment array is translated into the given language before serialization. If the requested target equals the actual source language, translation is a no-op (no surcharge, no upstream call) and the response is identical to a non-translate request.
- The response includes a `translatedFrom` field in the JSON payload alongside the existing `language` field, so the customer knows the source even after translation.

### Logic

**Tier selection at request time** is driven entirely by environment variables, not by per-request flags:
- If `STUB_TRANSLATION=true` (used in CI and local dev), use the stub translator. This is a pure function that returns the segment array with each `text` field rewritten as `[<src>→<tgt>] <originalText>`. Useful because it preserves segment count, timing, and lets every test assert "translation happened" without hitting the network.
- If `STUB_TRANSLATION=false` (the default in production) and `OPENAI_API_KEY` is set, use the OpenAI tier. This batches segments into chunks of around 20 at a time and sends a single chat completion per batch with structured JSON output: input is the source language, target language, and the array of texts; output is an array of translated texts in the same order. Reassembling is trivial — zip the translated texts back onto the original `start` and `dur` fields. The model is `gpt-4o-mini` because it's the cheapest model that produces translation quality on par with dedicated translation services, and it handles all of our supported languages well.
- If `STUB_TRANSLATION=false` and no OpenAI key is set, use the free `google-translate-api-x` tier. This calls Google Translate's unofficial endpoint which requires no API key but is rate-limited (the package handles backoff internally) and occasionally returns garbled output for long batches, so we send segments one at a time or in very small batches.

**Tier-down on failure.** If the chosen real-mode tier throws — OpenAI quota exceeded, network timeout, Google rate-limit ban, malformed response — the system falls down to the next available tier. OpenAI failure falls to Google; Google failure falls to the stub. The stub always succeeds. This means a translation request never returns a 5xx — at worst it returns a stub-flavored translation, which is obviously wrong but visibly wrong, which is better than a hard error in a paid request.

**Source-language detection.** Before deciding whether to translate, we compare the requested target against the actual source language of the cached or fetched transcript. If they match (e.g. customer asks for `translate_to=en` on an English transcript), we skip translation entirely and return the source as-is. No surcharge. No `translatedFrom` field in the response. This is important because customers running batch jobs may indiscriminately add `translate_to=en` to every request, and we shouldn't punish them for videos that are already in English.

**Preserve timing, replace text.** The translator only ever rewrites the `text` field of each segment. The `start` and `dur` are passed through untouched. This guarantees that a translated SRT or VTT file still aligns with the original video, which is essential for subtitle overlay use cases.

**Errors don't lose the transcript.** This is the most important behavioral rule. If all translation tiers fail (extremely unlikely because the stub always works, but theoretically possible if the stub itself throws on a malformed segment), the response should still return the source-language transcript with a response header `X-Translation-Failed: 1` and a warning field in the JSON payload. The customer is *not* charged the +1 translation surcharge in this case — they only pay the base transcript cost. The reasoning is that a customer who asked for Spanish and got English with a warning header can detect that and retry, whereas a customer who got a 500 has lost the transcript entirely and is now fighting their HTTP client to recover it.

**Surcharge accounting.** The +1 credit for translation is added to the base cost when the request is being priced, before the credit deduction transaction runs. If the deduction fails (insufficient credits), the request is rejected with 402 and no translation happens. If the deduction succeeds and translation later fails (per the rule above), the surcharge is refunded by inserting a compensating row in `credit_transactions` with `delta=+1`, `reason='translation_refund'`, and the running balance updated. The audit log shows both the deduction and the refund, which is the right paper trail for support questions.

**No caching.** Each translation request runs the translator every time, even for an identical video and target language pair. We are explicit about this in the API docs so customers don't expect repeated requests to be cheap. As a future enhancement, we may introduce a `translated_transcripts` table keyed on `(video_id, source_language, target_language)` and warm Redis under `transcript:<videoId>:<srcLang>:<tgtLang>`, with the same Postgres-canonical / Redis-warm pattern as the base cache. But not in MVP.

## Frontend

The transcript viewer page in the dashboard has a "Translate to" dropdown next to the existing format chooser. It lists the supported languages alphabetized by their English name with the ISO code in parentheses (e.g. "Spanish (es)"). Selecting a language re-fetches the transcript with `translate_to` set and rerenders the segment list inline. There is a small loading spinner because translation can take a few seconds for long videos.

The pricing page mentions translation under the per-request cost breakdown ("+1 credit for translation"). The API docs page shows an example request with `translate_to` and lists all supported language codes in a copy-pasteable block.

If a translation request returns the `X-Translation-Failed: 1` header, the dashboard surfaces a small toast "Translation unavailable, showing original" instead of silently displaying the source-language version. The customer is not charged in this case and the toast tells them so.

## Dependencies

The translation surcharge depends on the credits system (see credits-and-rate-limiting). The supported-language list is shared between the frontend picker and the backend validator but does not depend on any other feature being built first. Translation can be shipped before billing is real (stub mode covers everything).

## Verification

In dev with `STUB_TRANSLATION=true`, request a known video with `translate_to=es`. The response should have every segment's text prefixed with `[en→es]` (or whatever source/target applies), the segment count and timings should be unchanged, and the credit balance should drop by base + 1.

In real mode with `OPENAI_API_KEY` set, request a short English video with `translate_to=fr`. The response should be a coherent French translation, segment timings preserved, and the `translatedFrom` field should be `en`.

Pull the OpenAI key out, leave `STUB_TRANSLATION=false`, and re-request. The same request should succeed using the Google fallback tier — slower, slightly lower quality, but functional.

Force a translator failure (point `OPENAI_BASE_URL` at an unreachable host with no Google fallback configured). The response should return the source-language transcript with `X-Translation-Failed: 1`, the customer should *not* be charged the surcharge, and the audit log should show the base deduction with no surcharge row.

A request like `curl "https://api.example.com/v1/transcript?url=...&translate_to=ja" -H "Authorization: Bearer $KEY"` against a real English video should return a JSON payload with Japanese segment text and `language: ja`, `translatedFrom: en`.

Request the same English video with `translate_to=en`. The response should be identical to a no-translate request, no surcharge applied, no `translatedFrom` field.
