import { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { getUserById } from '../services/userService';
import { logger } from '../config/logger';

/**
 * Authorize a request as an operator. Composes after `sessionAuth` — the
 * session middleware has already verified the JWT and attached `req.user`
 * with `{ id, email }`. We do one DB lookup to confirm the user's row
 * still exists, isn't suspended, and carries `role = 'sys_admin'`.
 *
 * Why a fresh DB lookup rather than encoding `role` in the JWT:
 *   - The JWT is long-lived (7 days). Revoking admin should take effect
 *     immediately, not after the token expires.
 *   - The lookup is one indexed query and only runs on `/admin/*` routes,
 *     so the cost doesn't touch the hot `/me/*` paths.
 *   - We also catch the case of a deleted-but-not-yet-expired session
 *     trying to hit admin surfaces.
 */
export async function adminAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    // Should be impossible if `sessionAuth` ran first, but fail closed.
    return next(new UnauthorizedError('Sign in required', 'NO_SESSION'));
  }

  try {
    const user = await getUserById(req.user.id);
    if (!user) {
      // Session JWT references a user that no longer exists (account
      // deleted while the cookie was still valid).
      return next(new UnauthorizedError('Session user no longer exists', 'INVALID_SESSION'));
    }
    if (user.is_suspended) {
      return next(new ForbiddenError('Account is suspended'));
    }
    if (user.role !== 'sys_admin') {
      // Log so brute-force probing of /admin/* by ordinary sessions is
      // visible in production logs without leaking it to the caller.
      logger.warn(
        { userId: user.id, email: user.email, role: user.role, path: req.originalUrl },
        'Admin route access denied: non-admin user',
      );
      return next(new ForbiddenError('Admin privileges required'));
    }
    next();
  } catch (err) {
    next(err);
  }
}
