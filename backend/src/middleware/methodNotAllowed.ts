import { RequestHandler } from 'express';
import { MethodNotAllowedError } from '../utils/errors';

/**
 * Build a handler that responds 405 METHOD_NOT_ALLOWED for one exact path.
 *
 * Register it on a router AFTER the method-specific handlers for the same
 * path. A request whose method matched is already answered upstream, so only
 * an unsupported method falls through to here. Without it, a wrong method
 * (e.g. `DELETE /v1/transcript`) drops to the global 404 fallback and
 * misleadingly looks like the route does not exist.
 *
 * The `Allow` header is set per RFC 7231 §6.5.5 so clients can see which
 * verbs the endpoint accepts.
 */
export function methodNotAllowed(allowedMethods: string[]): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Allow', allowedMethods.join(', '));
    next(new MethodNotAllowedError(allowedMethods));
  };
}
