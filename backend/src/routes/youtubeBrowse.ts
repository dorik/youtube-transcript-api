import { Router } from 'express';
import { z } from 'zod';
import { apiKeyAuth } from '../middleware/apiKeyAuth';
import { rateLimit } from '../middleware/rateLimit';
import { deductCredits, getCreditState } from '../services/creditService';
import { pool } from '../db/pool';
import { logger } from '../config/logger';
import {
  getVideoMetadata,
  listChannelVideos,
  listPlaylistVideos,
  searchYouTube,
} from '../services/youtubeBrowseService';
import { PaymentRequiredError, ValidationError } from '../utils/errors';

export const youtubeBrowseRouter = Router();

const LimitSchema = z.coerce.number().int().min(1).max(50).default(10);

const SearchSchema = z.object({
  q: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  type: z.enum(['video', 'channel', 'playlist', 'all']).default('video'),
  limit: LimitSchema,
});

// Generic YouTube search returns a mix of videos / channels / playlists.
// Not a per-video listing, so we keep it at the single-request flat fee.
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

    await preflightBrowseCredit(req.user!.id, 1);
    const result = await searchYouTube({
      query,
      type: parsed.data.type,
      limit: parsed.data.limit,
    });
    await chargeBrowseCredit(req.user!.id, 'youtube_search', 1, { query, type: parsed.data.type });
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

    // Per-video billing on listings: pre-flight against the worst-case cost
    // (`limit`). Caller can pass a smaller limit to cap their spend.
    await preflightBrowseCredit(req.user!.id, parsed.data.limit);
    const result = await listChannelVideos({
      channel: parsed.data.channel,
      limit: parsed.data.limit,
    });
    const count = result.items.length;
    await chargeBrowseCredit(req.user!.id, 'channel_videos', count, {
      channel: parsed.data.channel,
      videos: count,
    });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/channel/videos', count);
    res.json({ ...result, credits_used: count });
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

    await preflightBrowseCredit(req.user!.id, parsed.data.limit);
    const result = await listChannelVideos({
      channel: parsed.data.channel,
      query,
      limit: parsed.data.limit,
    });
    const count = result.items.length;
    await chargeBrowseCredit(req.user!.id, 'channel_search', count, {
      channel: parsed.data.channel,
      query,
      videos: count,
    });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/channel/search', count);
    res.json({ ...result, query, credits_used: count });
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

    await preflightBrowseCredit(req.user!.id, parsed.data.limit);
    const result = await listChannelVideos({
      channel: parsed.data.channel,
      limit: parsed.data.limit,
    });
    const count = result.items.length;
    await chargeBrowseCredit(req.user!.id, 'channel_latest', count, {
      channel: parsed.data.channel,
      videos: count,
    });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/channel/latest', count);
    res.json({ ...result, credits_used: count });
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

    await preflightBrowseCredit(req.user!.id, parsed.data.limit);
    const result = await listPlaylistVideos({
      playlist,
      limit: parsed.data.limit,
    });
    const count = result.items.length;
    await chargeBrowseCredit(req.user!.id, 'playlist_videos', count, { playlist, videos: count });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/playlist/videos', count);
    res.json({ ...result, credits_used: count });
  } catch (err) {
    next(err);
  }
});

const MetadataSchema = z.object({
  url: z.string().min(1).optional(),
  video_id: z.string().min(1).optional(),
});

// Single-video metadata. One video = one credit (same outcome whether you
// think of it as "per request" or "per video"); kept at a flat 1.
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

    await preflightBrowseCredit(req.user!.id, 1);
    const result = await getVideoMetadata(input);
    await chargeBrowseCredit(req.user!.id, 'video_metadata', 1, { input });
    void logBrowseRequest(req.user!.id, req.apiKeyId ?? null, '/v1/video/metadata', 1);
    res.json({ ...result, credits_used: 1 });
  } catch (err) {
    next(err);
  }
});

/**
 * Reject 0-credit (or insufficient) users before we spend YouTube quota on
 * them. Pre-flight is best-effort — a race between this check and
 * `chargeBrowseCredit` is closed by `deductCredits` being transactional, so
 * the worst outcome is that we burn one YouTube fetch and still 402.
 */
async function preflightBrowseCredit(userId: string, maxCost: number): Promise<void> {
  const state = await getCreditState(userId);
  if (state.balance < maxCost) {
    throw new PaymentRequiredError(maxCost, state.balance);
  }
}

async function chargeBrowseCredit(
  userId: string,
  reason: string,
  amount: number,
  metadata: Record<string, unknown>,
): Promise<void> {
  // Zero-result listings cost nothing. The pre-flight already ensured the
  // user can pay up to `limit`, but a channel might actually return 0 videos
  // — there's nothing to charge for.
  if (amount <= 0) return;
  await deductCredits({
    userId,
    amount,
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
        (user_id, api_key_id, method, endpoint, status_code,
         credits_used, response_time_ms, format)
       VALUES ($1, $2, 'GET', $3, 200, $4, $5, $6)`,
      [userId, apiKeyId, endpoint, creditsUsed, null, null],
    );
  } catch (err) {
    logger.warn({ err, endpoint }, 'Failed to log browse request (non-fatal)');
  }
}
