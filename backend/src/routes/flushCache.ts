import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { flushAllCache } from '../services/cacheService';
import { NotFoundError, UnauthorizedError } from '../utils/errors';

/**
 * `POST /flush-cache?secret=...` — hard reset of the cache for the
 * environment it runs in: Redis `FLUSHALL` plus a truncate of the Postgres
 * cache tables (so the cold tier can't re-warm Redis with stale rows).
 *
 * Auth is a single shared secret in the query string (`CACHE_FLUSH_SECRET`),
 * deliberately separate from the dashboard session + `sys_admin` role that
 * gates `/admin/*`. The trade-off is intentional: this endpoint needs to be
 * callable with a bare `curl` against any environment without provisioning a
 * sys_admin account or juggling session cookies.
 *
 * Each environment (local/dev/prod) hits its own Redis instance, so one call
 * clears one environment — clear all three by calling each URL once.
 *
 * When `CACHE_FLUSH_SECRET` is unset the route 404s, so an environment that
 * never configured a secret can't be flushed by an empty `?secret=`.
 */
export const flushCacheRouter = Router();

function secretMatches(provided: string): boolean {
  const expected = config.CACHE_FLUSH_SECRET;
  if (!expected || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; check first, and the early
  // return still leaks length but not content.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

flushCacheRouter.post('/', async (req, res, next) => {
  try {
    if (!config.CACHE_FLUSH_SECRET) {
      // Endpoint disabled for this environment — indistinguishable from a
      // route that doesn't exist.
      throw new NotFoundError('Not found', 'ROUTE_NOT_FOUND');
    }

    const provided =
      typeof req.query.secret === 'string' ? req.query.secret : '';
    if (!secretMatches(provided)) {
      throw new UnauthorizedError('Invalid or missing secret', 'INVALID_SECRET');
    }

    const result = await flushAllCache();
    logger.warn(
      {
        ip: req.ip,
        redis: result.redis,
        postgres: result.postgres,
      },
      'Cache flushed via /flush-cache',
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});
