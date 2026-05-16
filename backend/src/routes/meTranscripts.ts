import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../middleware/sessionAuth';
import { VALID_FORMATS, OutputFormat } from '../services/formatters';
import { ValidationError } from '../utils/errors';
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
    res.status(row.status === 'queued' ? 202 : 200).json(row);
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
    const { limit, offset } = ListSchema.parse(req.query);
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
      res.status(404).json({ error: 'not_found', code: 'NOT_FOUND' });
      return;
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
      res.status(404).json({ error: 'not_found', code: 'NOT_FOUND' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});
