import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../middleware/sessionAuth';
import { adminAuth } from '../middleware/adminAuth';
import { logger } from '../config/logger';
import { clearCache } from '../services/cacheService';
import { ValidationError } from '../utils/errors';

/**
 * Operator-only endpoints. Authentication is the standard dashboard
 * session cookie (`sessionAuth`); authorization is `role = 'sys_admin'`
 * on the user row (`adminAuth`). Non-admin sessions hit a 403; missing
 * sessions hit a 401 — same shapes as the rest of the API, no special
 * out-of-band token.
 *
 * To grant admin: `UPDATE users SET role = 'sys_admin' WHERE email = '<x>';`
 */
export const adminRouter = Router();

// Order matters: sessionAuth populates `req.user` from the cookie, then
// adminAuth does the role lookup on top.
adminRouter.use(sessionAuth, adminAuth);

const ClearBodySchema = z
  .object({
    video_id: z.string().min(1).max(32).optional(),
  })
  // Body is optional — POST with no body == "clear everything".
  .partial()
  .default({});

adminRouter.post('/cache/clear', async (req, res, next) => {
  try {
    const parsed = ClearBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid body', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await clearCache(parsed.data.video_id);
    logger.warn(
      {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        scope: result.scope,
        videoId: result.videoId,
        redis: result.redis,
        postgres: result.postgres,
      },
      'Admin: cache cleared',
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});
