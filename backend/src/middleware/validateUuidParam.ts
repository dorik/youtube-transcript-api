import { RequestHandler } from 'express';
import { NotFoundError } from '../utils/errors';

/**
 * RFC-4122 UUID, any version. Postgres `uuid` columns accept exactly this
 * shape — anything else triggers a `22P02` "invalid input syntax for type
 * uuid" cast error deep inside a `WHERE id = $1` query. That error is not an
 * `ApiError`, so the global handler can only surface it as an opaque
 * `500 INTERNAL_ERROR` (bug H1).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reject a non-UUID `:param` path segment before it can reach a `uuid` column.
 *
 * Returns `404 NOT_FOUND`: a malformed id cannot identify any row, so "not
 * found" is the honest answer — and it keeps the contract consistent with a
 * well-formed-but-unknown UUID, which already returns 404. This converts the
 * spurious 500s (which also pollute error dashboards) into a correct 4xx.
 */
export function validateUuidParam(param: string): RequestHandler {
  return (req, _res, next) => {
    const value = req.params[param];
    if (!value || !UUID_RE.test(value)) {
      next(new NotFoundError('The requested resource does not exist.'));
      return;
    }
    next();
  };
}
