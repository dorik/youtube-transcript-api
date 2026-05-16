import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../middleware/sessionAuth';
import { VALID_FORMATS, OutputFormat } from '../services/formatters';
import { ValidationError, NotFoundError } from '../utils/errors';
import * as svc from '../services/transcriptRequestService';
import {
  listPlaylistVideos,
  listChannelVideos,
} from '../services/youtubeBrowseService';
import { extractVideoId } from '../utils/youtubeUrl';

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

const BulkSchema = z
  .object({
    // Exactly one of these identifies the batch source.
    playlist: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    urls: z.array(z.string().min(1)).min(1).max(svc.BATCH_VIDEO_CAP).optional(),
    format: z
      .enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]])
      .default('json'),
    language: z.string().min(2).max(10).optional(),
    native_only: z.boolean().optional(),
    translate_to: z.string().min(2).max(10).optional(),
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
  });

meTranscriptsRouter.post('/bulk', async (req, res, next) => {
  try {
    const parsed = BulkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;
    const config = {
      format: data.format,
      language: data.language,
      native_only: data.native_only,
      translate_to: data.translate_to,
    };

    let kind: 'playlist' | 'channel' | 'videos';
    let sourceUrl: string | null = null;
    let label: string | null = null;
    let videos: svc.BatchVideoInput[];

    if (data.playlist) {
      kind = 'playlist';
      sourceUrl = data.playlist;
      label = data.playlist;
      const listing = await listPlaylistVideos({
        playlist: data.playlist,
        limit: data.limit,
      });
      videos = listing.items.map((v) => ({
        url: v.url,
        video_id: v.video_id,
        title: v.title,
        channel: v.channel,
        thumbnail_url: v.thumbnail_url,
      }));
    } else if (data.channel) {
      kind = 'channel';
      sourceUrl = data.channel;
      label = data.channel;
      const listing = await listChannelVideos({
        channel: data.channel,
        limit: data.limit,
      });
      videos = listing.items.map((v) => ({
        url: v.url,
        video_id: v.video_id,
        title: v.title,
        channel: v.channel,
        thumbnail_url: v.thumbnail_url,
      }));
    } else if (data.urls) {
      kind = 'videos';
      videos = data.urls.map((url, index) => {
        try {
          return { url, video_id: extractVideoId(url) };
        } catch {
          throw new ValidationError(
            `Invalid URL at index ${index}: ${url}`,
          );
        }
      });
    } else {
      throw new ValidationError('Provide exactly one of: playlist, channel, urls');
    }

    const result = await svc.enqueueBatch({
      userId: req.user!.id,
      kind,
      sourceUrl,
      label,
      videos,
      config,
    });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

meTranscriptsRouter.get('/batches/:id', async (req, res, next) => {
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
