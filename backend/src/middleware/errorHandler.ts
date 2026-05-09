import { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/errors';
import { logger } from '../config/logger';

/**
 * Global Express error handler. Wraps `ApiError` subclasses into their JSON
 * envelope; everything else becomes a generic 500 with no internals leaked.
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) => {
  if (err instanceof ApiError) {
    if (err.status >= 500) {
      logger.error({ err, path: req.path }, 'Server error in handler');
    } else {
      logger.warn({ code: err.code, path: req.path }, 'Client error');
    }
    res.status(err.status).json(err.toJSON());
    return;
  }

  // Unknown error: log full details, return opaque 500.
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({
    error: 'internal_error',
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred. Please try again later.',
  });
};

/**
 * 404 fallback for unmatched routes — must be mounted after all routes.
 */
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({
    error: 'not_found',
    code: 'ROUTE_NOT_FOUND',
    message: 'The requested route does not exist.',
  });
}
