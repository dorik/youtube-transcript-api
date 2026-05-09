import { NextFunction, Request, Response } from 'express';
import { redis } from '../cache/redis';
import { config } from '../config/env';
import { RateLimitError } from '../utils/errors';

/**
 * Fixed-window rate limit per API key (or per user if no key). Uses Redis
 * INCR + EXPIRE — simple and good enough for MVP.
 *
 * Future work: switch to a token bucket or sliding window for smoother
 * limiting under bursty traffic.
 */
export async function rateLimit(req: Request, res: Response, next: NextFunction) {
  try {
    const subject = req.apiKeyId ?? req.user?.id ?? req.ip ?? 'anon';
    const limit = config.RATE_LIMIT_REQUESTS_PER_MIN;
    const windowSeconds = 60;
    const bucketKey = `ratelimit:${subject}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;

    const current = await redis.incr(bucketKey);
    if (current === 1) {
      await redis.expire(bucketKey, windowSeconds);
    }

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - current)));
    res.setHeader(
      'X-RateLimit-Reset',
      String(Math.ceil(Date.now() / 1000 / windowSeconds + 1) * windowSeconds),
    );

    if (current > limit) {
      const ttl = await redis.ttl(bucketKey);
      throw new RateLimitError(ttl > 0 ? ttl : windowSeconds);
    }

    next();
  } catch (err) {
    next(err);
  }
}
