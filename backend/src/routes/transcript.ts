import { Router } from 'express';
import { z } from 'zod';
import { apiKeyAuth } from '../middleware/apiKeyAuth';
import { rateLimit } from '../middleware/rateLimit';
import { getTranscript } from '../services/transcriptService';
import { VALID_FORMATS, OutputFormat } from '../services/formatters';
import { ValidationError } from '../utils/errors';
import { pool } from '../db/pool';
import { logger } from '../config/logger';

export const transcriptRouter = Router();

const QuerySchema = z.object({
  url: z.string().min(1, 'url is required'),
  format: z.enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]]).default('json'),
  language: z.string().min(2).max(10).optional(),
  // Accept "true" / "1" / "yes" as truthy, anything else as false.
  native_only: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1' || v === 'yes'),
  /** ISO 639-1 code, 'none', or omitted. See translationService. */
  translate_to: z.string().min(2).max(10).optional(),
});

transcriptRouter.get('/transcript', apiKeyAuth, rateLimit, async (req, res, next) => {
  const startedAt = Date.now();
  let parsed: z.infer<typeof QuerySchema> | null = null;
  let videoId: string | null = null;
  let result: Awaited<ReturnType<typeof getTranscript>> | null = null;
  let errorCode: string | null = null;
  let statusCode = 200;

  try {
    const parseResult = QuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError('Invalid query parameters', {
        issues: parseResult.error.flatten().fieldErrors,
      });
    }
    parsed = parseResult.data;

    result = await getTranscript({
      userId: req.user!.id,
      url: parsed.url,
      format: parsed.format,
      language: parsed.language,
      nativeOnly: parsed.native_only,
      translateTo: parsed.translate_to,
    });
    videoId = result.video_id;

    res.setHeader('X-Transcript-Source', result.source);
    res.setHeader('X-Transcript-Cached', result.cached ? '1' : '0');

    if (parsed.format === 'srt' || parsed.format === 'vtt') {
      // For raw subtitle formats, return the file content with the right
      // mime type. JSON envelope is still available via format=json.
      res.setHeader(
        'Content-Type',
        parsed.format === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8',
      );
      res.send(result.transcript);
    } else if (parsed.format === 'text' || parsed.format === 'text-timestamps') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(result.transcript);
    } else {
      res.json(result);
    }
  } catch (err) {
    statusCode =
      err && typeof err === 'object' && 'status' in err && typeof (err as any).status === 'number'
        ? (err as any).status
        : 500;
    errorCode =
      err && typeof err === 'object' && 'code' in err ? String((err as any).code) : 'INTERNAL_ERROR';
    next(err);
    return;
  } finally {
    // Background log of the request to api_requests. Best-effort.
    void logRequest({
      userId: req.user?.id ?? null,
      apiKeyId: req.apiKeyId ?? null,
      method: 'GET',
      endpoint: '/v1/transcript',
      statusCode,
      videoUrl: parsed?.url ?? (req.query.url as string | undefined) ?? null,
      videoId,
      format: parsed?.format ?? null,
      language: parsed?.language ?? null,
      responseMs: Date.now() - startedAt,
      transcriptSource: result?.source ?? null,
      cacheHit: result?.cached ?? null,
      creditsUsed: result?.credits_used ?? null,
      errorCode,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
    });
  }
});

interface RequestLogInput {
  userId: string | null;
  apiKeyId: string | null;
  method: string;
  endpoint: string;
  statusCode: number;
  videoUrl: string | null;
  videoId: string | null;
  format: string | null;
  language: string | null;
  responseMs: number;
  transcriptSource: string | null;
  cacheHit: boolean | null;
  creditsUsed: number | null;
  errorCode: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

async function logRequest(r: RequestLogInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO api_requests
        (user_id, api_key_id, method, endpoint, status_code,
         video_url, video_id, format, language, response_time_ms,
         transcript_source, cache_hit, credits_used, error_code,
         ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        r.userId,
        r.apiKeyId,
        r.method,
        r.endpoint,
        r.statusCode,
        r.videoUrl,
        r.videoId,
        r.format,
        r.language,
        r.responseMs,
        r.transcriptSource,
        r.cacheHit,
        r.creditsUsed,
        r.errorCode,
        r.ipAddress,
        r.userAgent,
      ],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to log api_requests row (non-fatal)');
  }
}
