import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../middleware/sessionAuth';
import { getTranscript } from '../services/transcriptService';
import { VALID_FORMATS, OutputFormat } from '../services/formatters';
import { ValidationError } from '../utils/errors';
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
  try {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await getTranscript({
      userId: req.user!.id,
      url: parsed.data.url,
      format: parsed.data.format,
      language: parsed.data.language,
      nativeOnly: parsed.data.native_only,
      translateTo: parsed.data.translate_to,
    });

    // Log to the same api_requests audit so dashboard usage charts stay
    // accurate regardless of which entry point the user hit.
    void pool
      .query(
        `INSERT INTO api_requests
          (user_id, method, endpoint, status_code,
           video_url, video_id, format, language, response_time_ms,
           transcript_source, cache_hit, credits_used, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          req.user!.id,
          'GET',
          '/me/transcript',
          200,
          parsed.data.url,
          result.video_id,
          parsed.data.format,
          parsed.data.language ?? null,
          Date.now() - startedAt,
          result.source,
          result.cached,
          result.credits_used,
          req.ip ?? null,
          req.headers['user-agent']?.slice(0, 500) ?? null,
        ],
      )
      .catch((err) => logger.warn({ err }, 'Failed to log /me/transcript request'));

    res.json(result);
  } catch (err) {
    next(err);
  }
});
