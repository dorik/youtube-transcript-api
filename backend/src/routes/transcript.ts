import { Router } from 'express';
import { z } from 'zod';
import { apiKeyAuth } from '../middleware/apiKeyAuth';
import { rateLimit } from '../middleware/rateLimit';
import { VALID_FORMATS, OutputFormat } from '../services/formatters';
import { ValidationError, NotFoundError } from '../utils/errors';
import * as svc from '../services/transcriptRequestService';
import { expandBulkSource } from '../services/bulkExpansion';
import { languageField, translateToField } from '../utils/languageFields';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

/**
 * `/v1/transcript` — public, API-key-authed transcript queue.
 *
 *   POST /v1/transcript              enqueue a request, returns 202 + entry
 *   GET  /v1/transcript/:id          poll one entry
 *   POST /v1/transcripts/bulk        expand a playlist/channel/URL-list and enqueue the batch
 *   GET  /v1/transcripts/batches/:id poll a batch's progress and entries
 *
 * Async-only: enqueue returns instantly. Bulk operations are enqueued via
 * POST /v1/transcripts/bulk and polled via GET /v1/transcripts/batches/:id.
 *
 * BREAKING CHANGE vs. the old synchronous GET /v1/transcript.
 */
export const transcriptRouter = Router();

const CreateSchema = z.object({
  url: z.string().min(1, 'url is required'),
  format: z
    .enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]])
    .default('json'),
  language: languageField,
  native_only: z.boolean().optional(),
  translate_to: translateToField,
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

const BulkSchema = z
  .object({
    playlist: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    channelMode: z.enum(['videos', 'latest', 'search']).default('videos'),
    channelQuery: z.string().min(1).optional(),
    urls: z
      .array(z.string().min(1))
      .min(1)
      .max(svc.BATCH_VIDEO_CAP)
      .optional(),
    format: z
      .enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]])
      .default('json'),
    language: languageField,
    native_only: z.boolean().optional(),
    translate_to: translateToField,
    limit: z.coerce.number().int().min(1).max(svc.BATCH_VIDEO_CAP).default(50),
  })
  .superRefine((val, ctx) => {
    const sourceCount =
      (val.playlist ? 1 : 0) +
      (val.channel ? 1 : 0) +
      (val.urls && val.urls.length > 0 ? 1 : 0);
    if (sourceCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exactly one of: playlist, channel, urls',
      });
    }
    if (val.channel && val.channelMode === 'search' && !val.channelQuery?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channelQuery is required when channelMode is "search"',
      });
    }
  });

/**
 * POST /v1/transcripts/bulk — public, API-key-authed bulk enqueue. Expands a
 * playlist/channel/URL-list, queues one job per video, and returns 202 with
 * the batch and its queued entries. Async-only: transcripts are polled via
 * GET /v1/transcripts/batches/:id.
 */
transcriptRouter.post(
  '/transcripts/bulk',
  apiKeyAuth,
  rateLimit,
  async (req, res, next) => {
    try {
      const parsed = BulkSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', {
          issues: parsed.error.flatten().fieldErrors,
        });
      }
      const data = parsed.data;
      const { kind, sourceUrl, label, videos } = await expandBulkSource({
        playlist: data.playlist,
        channel: data.channel,
        channelMode: data.channelMode,
        channelQuery: data.channelQuery,
        urls: data.urls,
        limit: data.limit,
      });
      const result = await svc.enqueueBatch({
        userId: req.user!.id,
        kind,
        sourceUrl,
        label,
        videos,
        config: {
          format: data.format,
          language: data.language,
          native_only: data.native_only,
          translate_to: data.translate_to,
        },
      });
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /v1/transcripts/batches/:id — poll a batch's summary, derived progress
 * counts, and entries. User-scoped to the API key's owner.
 */
transcriptRouter.get(
  '/transcripts/batches/:id',
  apiKeyAuth,
  rateLimit,
  async (req, res, next) => {
    try {
      const batch = await svc.getBatch(req.params.id, req.user!.id);
      if (!batch) {
        throw new NotFoundError('Batch not found');
      }
      const [progress, requests] = await Promise.all([
        svc.getBatchProgress(batch.id),
        svc.listBatchRequests(batch.id),
      ]);
      res.json({ batch, progress, requests });
    } catch (err) {
      next(err);
    }
  },
);

// 405 METHOD_NOT_ALLOWED for the paths above when the HTTP verb doesn't
// match. Registered last so the method-specific handlers always win; only an
// unsupported method falls through here instead of dropping to the global 404.
transcriptRouter.all('/transcript', methodNotAllowed(['POST']));
transcriptRouter.all('/transcript/:id', methodNotAllowed(['GET']));
transcriptRouter.all('/transcripts/bulk', methodNotAllowed(['POST']));
transcriptRouter.all('/transcripts/batches/:id', methodNotAllowed(['GET']));
