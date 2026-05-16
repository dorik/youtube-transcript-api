import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../middleware/sessionAuth';
import { VALID_FORMATS, OutputFormat } from '../services/formatters';
import { ValidationError, NotFoundError } from '../utils/errors';
import * as svc from '../services/transcriptRequestService';

/**
 * `/me/transcripts` — cookie-authed async transcript queue for the dashboard.
 *
 *   POST   /me/transcripts            enqueue one request
 *   POST   /me/transcripts/bulk       enqueue a playlist/channel/list batch
 *   GET    /me/transcripts            list the user's requests
 *   GET    /me/transcripts/batches/:id  batch summary + entries
 *   GET    /me/transcripts/:id        one request
 *   DELETE /me/transcripts/:id        cancel a queued request
 *
 * Literal sub-paths are registered before the `/:id` param route.
 */
export const meTranscriptsRouter = Router();

meTranscriptsRouter.use(sessionAuth);

const CreateSchema = z.object({
  url: z.string().min(1, 'url is required'),
  format: z
    .enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]])
    .default('json'),
  language: z.string().min(2).max(10).optional(),
  native_only: z.boolean().optional(),
  translate_to: z.string().min(2).max(10).optional(),
});

meTranscriptsRouter.post('/', async (req, res, next) => {
  try {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const row = await svc.enqueueSingleRequest({
      userId: req.user!.id,
      source: 'dashboard',
      config: parsed.data,
    });
    // 202 for queued/processing (still in flight); 200 only for a completed cache hit
    res.status(row.status === 'queued' || row.status === 'processing' ? 202 : 200).json(row);
  } catch (err) {
    next(err);
  }
});

const ListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

meTranscriptsRouter.get('/', async (req, res, next) => {
  try {
    const parsed = ListSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const { limit, offset } = parsed.data;
    const result = await svc.listUserRequests(req.user!.id, limit, offset);
    res.json({ ...result, limit, offset });
  } catch (err) {
    next(err);
  }
});

meTranscriptsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await svc.getUserRequest(req.params.id, req.user!.id);
    if (!row) {
      throw new NotFoundError('Transcript request not found');
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

meTranscriptsRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await svc.cancelRequest(req.params.id, req.user!.id);
    if (!row) {
      throw new NotFoundError('Transcript request not found');
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});
