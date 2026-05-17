import { z } from 'zod';
import { isSupportedLanguageCode } from './languageCodes';

/**
 * Shared zod field schemas for the transcript-request `language` and
 * `translate_to` inputs.
 *
 * Both the public API (`/v1/transcript`) and the dashboard queue
 * (`/me/transcripts`) accept these fields and feed the *same* downstream
 * pipeline, so their validation must be identical. Defining the schemas once
 * stops the two routes from drifting — an unsupported value like `zzzz` is
 * rejected with a 400 VALIDATION_ERROR at the door instead of failing deep
 * inside the translator as an opaque 500.
 *
 * `auto` (let YouTube pick the track) and `none` (no translation) are valid
 * sentinels the orchestrator understands; every other value must resolve to a
 * language code this API supports.
 */
export const languageField = z
  .string()
  .min(2)
  .max(10)
  .refine((v) => v === 'auto' || isSupportedLanguageCode(v), {
    message: 'Unsupported language code',
  })
  .optional();

export const translateToField = z
  .string()
  .min(2)
  .max(10)
  .refine((v) => v === 'none' || isSupportedLanguageCode(v), {
    message: 'Unsupported translate_to language code',
  })
  .optional();
