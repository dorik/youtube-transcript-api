import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../middleware/sessionAuth';
import { getTranscript } from '../services/transcriptService';
import { VALID_FORMATS, OutputFormat } from '../services/formatters';
import { ValidationError } from '../utils/errors';
import { extractVideoId } from '../utils/youtubeUrl';
import { pool } from '../db/pool';
import { logger } from '../config/logger';

/**
 * Cookie-authed mirror of GET /v1/transcript. The dashboard's transcript
 * viewer uses this so we don't have to expose plaintext API keys to the
 * browser. Same orchestration, same credit math, same cache.
 */
export const meTranscriptRouter = Router();

meTranscriptRouter.use(sessionAuth);

const QuerySchema = z.object({
  url: z.string().min(1, 'url is required'),
  format: z
    .enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]])
    .default('json'),
  language: z.string().min(2).max(10).optional(),
  native_only: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1' || v === 'yes'),
  translate_to: z.string().min(2).max(10).optional(),
});

meTranscriptRouter.get('/', async (req, res, next) => {
  const startedAt = Date.now();
  // Pulled out of the try block so the `finally` log can include them whether
  // the request succeeded or threw. Mirrors the /v1/transcript pattern so
  // dashboard usage charts capture failed requests too — without this,
  // upgrade_required / insufficient_credits / no_transcript responses were
  // invisible in "Recent activity".
  let parsed: z.infer<typeof QuerySchema> | null = null;
  let videoId: string | null = null;
  let result: Awaited<ReturnType<typeof getTranscript>> | null = null;
  let statusCode = 200;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  try {
    const parseResult = QuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError('Invalid query parameters', {
        issues: parseResult.error.flatten().fieldErrors,
      });
    }
    parsed = parseResult.data;

    // Resolve the video_id up front so the failure-path log row has it.
    // extractVideoId throws ValidationError on a malformed URL; we swallow
    // that here (log row gets video_id=null and getTranscript will re-throw
    // the same error in a moment, which the catch block records normally).
    try {
      videoId = extractVideoId(parsed.url);
    } catch {
      videoId = null;
    }

    result = await getTranscript({
      userId: req.user!.id,
      url: parsed.url,
      format: parsed.format,
      language: parsed.language,
      nativeOnly: parsed.native_only,
      translateTo: parsed.translate_to,
    });

    res.json(result);
  } catch (err) {
    statusCode =
      err && typeof err === 'object' && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    errorCode =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : 'INTERNAL_ERROR';
    errorMessage =
      err instanceof Error ? err.message.slice(0, 500) : null;
    next(err);
    return;
  } finally {
    // Background log. Best-effort — never block the response.
    void pool
      .query(
        `INSERT INTO api_requests
          (user_id, method, endpoint, status_code,
           video_url, video_id, format, language, response_time_ms,
           transcript_source, cache_hit, credits_used,
           error_code, error_message, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          req.user!.id,
          'GET',
          '/me/transcript',
          statusCode,
          parsed?.url ?? (req.query.url as string | undefined) ?? null,
          result?.video_id ?? videoId,
          parsed?.format ?? null,
          parsed?.language ?? null,
          Date.now() - startedAt,
          result?.source ?? null,
          result?.cached ?? null,
          result?.credits_used ?? null,
          errorCode,
          errorMessage,
          req.ip ?? null,
          req.headers['user-agent']?.slice(0, 500) ?? null,
        ],
      )
      .catch((err) =>
        logger.warn({ err }, 'Failed to log /me/transcript request'),
      );
  }
});
