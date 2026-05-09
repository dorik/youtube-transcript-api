import { NextFunction, Request, Response } from 'express';
import { resolveApiKey, touchApiKey } from '../services/apiKeyService';
import { UnauthorizedError } from '../utils/errors';

/**
 * Validates `Authorization: Bearer <key>` against the api_keys table.
 *
 * On success, attaches `req.user` and `req.apiKeyId`. On failure, throws an
 * `UnauthorizedError` — the global error handler returns it as a 401.
 */
export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header) {
      throw new UnauthorizedError(
        'Missing Authorization header. Use: Authorization: Bearer <api_key>',
        'MISSING_API_KEY',
      );
    }
    if (!header.startsWith('Bearer ')) {
      throw new UnauthorizedError(
        'Authorization header must use the Bearer scheme',
        'INVALID_AUTH_SCHEME',
      );
    }
    const key = header.slice('Bearer '.length).trim();
    if (!key.startsWith('yt_')) {
      throw new UnauthorizedError('Invalid API key format', 'INVALID_API_KEY');
    }

    const resolved = await resolveApiKey(key);
    if (!resolved) {
      throw new UnauthorizedError('Invalid or revoked API key', 'INVALID_API_KEY');
    }

    req.user = { id: resolved.userId, email: resolved.email };
    req.apiKeyId = resolved.apiKeyId;

    // Fire-and-forget timestamp update so the request doesn't wait on a write
    void touchApiKey(resolved.apiKeyId);

    next();
  } catch (err) {
    next(err);
  }
}
