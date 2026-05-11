import { Router } from 'express';
import { z } from 'zod';
import { apiKeyAuth } from '../middleware/apiKeyAuth';
import { rateLimit } from '../middleware/rateLimit';
import { deductCredits } from '../services/creditService';
import { pool } from '../db/pool';
import { logger } from '../config/logger';
import {
  getVideoMetadata,
  listChannelVideos,
  listPlaylistVideos,
  searchYouTube,
} from '../services/youtubeBrowseService';
import { ValidationError } from '../utils/errors';

export const youtubeBrowseRouter = Router();

const LimitSchema = z.coerce.number().int().min(1).max(50).default(10);

const SearchSchema = z.object({
  q: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  type: z.enum(['video', 'channel', 'playlist', 'all']).default('video'),
  limit: LimitSchema,
});

youtubeBrowseRouter.get('/search', apiKeyAuth, rateLimit, async (req, res, next) => {
  try {
    const parsed = SearchSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const query = parsed.data.q ?? parsed.data.query;
    if (!query) throw new ValidationError('q or query is required');

    const result = await searchYouTube({
      query,
      type: parsed.data.type,
      limit: parsed.data.limit,
    });
    await chargeBrowseCredit(req.user!.id, 'youtube_search', { query, type: parsed.data.type });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/search', 1);
    res.json({ ...result, credits_used: 1 });
  } catch (err) {
    next(err);
  }
});

const ChannelVideosSchema = z.object({
  channel: z.string().min(1),
  limit: LimitSchema,
});

youtubeBrowseRouter.get('/channel/videos', apiKeyAuth, rateLimit, async (req, res, next) => {
  try {
    const parsed = ChannelVideosSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await listChannelVideos({
      channel: parsed.data.channel,
      limit: parsed.data.limit,
    });
    await chargeBrowseCredit(req.user!.id, 'channel_videos', { channel: parsed.data.channel });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/channel/videos', 1);
    res.json({ ...result, credits_used: 1 });
  } catch (err) {
    next(err);
  }
});

const ChannelSearchSchema = z.object({
  channel: z.string().min(1),
  q: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: LimitSchema,
});

youtubeBrowseRouter.get('/channel/search', apiKeyAuth, rateLimit, async (req, res, next) => {
  try {
    const parsed = ChannelSearchSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const query = parsed.data.q ?? parsed.data.query;
    if (!query) throw new ValidationError('q or query is required');

    const result = await listChannelVideos({
      channel: parsed.data.channel,
      query,
      limit: parsed.data.limit,
    });
    await chargeBrowseCredit(req.user!.id, 'channel_search', {
      channel: parsed.data.channel,
      query,
    });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/channel/search', 1);
    res.json({ ...result, query, credits_used: 1 });
  } catch (err) {
    next(err);
  }
});

youtubeBrowseRouter.get('/channel/latest', apiKeyAuth, rateLimit, async (req, res, next) => {
  try {
    const parsed = ChannelVideosSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await listChannelVideos({
      channel: parsed.data.channel,
      limit: parsed.data.limit,
    });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/channel/latest', 0);
    res.json({ ...result, credits_used: 0 });
  } catch (err) {
    next(err);
  }
});

const PlaylistSchema = z.object({
  playlist: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  list: z.string().min(1).optional(),
  limit: LimitSchema,
});

youtubeBrowseRouter.get('/playlist/videos', apiKeyAuth, rateLimit, async (req, res, next) => {
  try {
    const parsed = PlaylistSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const playlist = parsed.data.playlist ?? parsed.data.url ?? parsed.data.list;
    if (!playlist) throw new ValidationError('playlist, url, or list is required');

    const result = await listPlaylistVideos({
      playlist,
      limit: parsed.data.limit,
    });
    await chargeBrowseCredit(req.user!.id, 'playlist_videos', { playlist });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/playlist/videos', 1);
    res.json({ ...result, credits_used: 1 });
  } catch (err) {
    next(err);
  }
});

const MetadataSchema = z.object({
  url: z.string().min(1).optional(),
  video_id: z.string().min(1).optional(),
});

youtubeBrowseRouter.get('/video/metadata', apiKeyAuth, rateLimit, async (req, res, next) => {
  try {
    const parsed = MetadataSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const input = parsed.data.url ?? parsed.data.video_id;
    if (!input) throw new ValidationError('url or video_id is required');

    const result = await getVideoMetadata(input);
    await chargeBrowseCredit(req.user!.id, 'video_metadata', { input });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/video/metadata', 1);
    res.json({ ...result, credits_used: 1 });
  } catch (err) {
    next(err);
  }
});

async function chargeBrowseCredit(
  userId: string,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await deductCredits({
    userId,
    amount: 1,
    reason,
    metadata,
  });
}

async function logBrowseRequest(
  userId: string,
  apiKeyId: string | null,
  endpoint: string,
  creditsUsed: number,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO api_requests
        (user_id, api_key_id, method, endpoint, status_code, credits_used)
       VALUES ($1, $2, 'GET', $3, 200, $4)`,
      [userId, apiKeyId, endpoint, creditsUsed],
    );
  } catch (err) {
    logger.warn({ err, endpoint }, 'Failed to log browse request (non-fatal)');
  }
}
