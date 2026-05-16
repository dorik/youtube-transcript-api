import { Router } from 'express';
import { z } from 'zod';
import { apiKeyAuth } from '../middleware/apiKeyAuth';
import { rateLimit } from '../middleware/rateLimit';
import { VALID_FORMATS, OutputFormat } from '../services/formatters';
import { ValidationError, NotFoundError } from '../utils/errors';
import * as svc from '../services/transcriptRequestService';

/**
 * `/v1/transcript` — public, API-key-authed transcript queue.
 *
 *   POST /v1/transcript         enqueue a request, returns 202 + entry
 *   GET  /v1/transcript/:id     poll one entry
 *
 * Async-only: enqueue returns instantly. To transcribe a playlist, a consumer
 * loops POST per video URL — there is no API bulk endpoint (see design doc).
 *
 * BREAKING CHANGE vs. the old synchronous GET /v1/transcript.
 */
export const transcriptRouter = Router();

const CreateSchema = z.object({
  url: z.string().min(1, 'url is required'),
  format: z
    .enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]])
    .default('json'),
  language: z.string().min(2).max(10).optional(),
  native_only: z.boolean().optional(),
  translate_to: z.string().min(2).max(10).optional(),
});

transcriptRouter.post(
  '/transcript',
  apiKeyAuth,
  rateLimit,
  async (req, res, next) => {
    try {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', {
          issues: parsed.error.flatten().fieldErrors,
        });
      }
      const row = await svc.enqueueSingleRequest({
        userId: req.user!.id,
        source: 'api',
        config: parsed.data,
      });
      // 202 for queued/processing (still in flight); 200 only for a completed cache hit
      res.status(row.status === 'queued' || row.status === 'processing' ? 202 : 200).json(row);
    } catch (err) {
      next(err);
    }
  },
);

transcriptRouter.get(
  '/transcript/:id',
  apiKeyAuth,
  rateLimit,
  async (req, res, next) => {
    try {
      const row = await svc.getUserRequest(req.params.id, req.user!.id);
      if (!row) {
        throw new NotFoundError('Transcript request not found');
      }
      res.json(row);
    } catch (err) {
      next(err);
    }
  },
);
