import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { UnauthorizedError } from '../utils/errors';

interface SessionPayload {
  sub: string; // user id
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
      apiKeyId?: string;
    }
  }
}

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifySession(token: string): SessionPayload {
  return jwt.verify(token, config.JWT_SECRET) as SessionPayload;
}

/**
 * Reads the JWT cookie and attaches `req.user`. Throws 401 if missing or
 * invalid. Use on every route under `/me/*` and dashboard-only routes.
 */
export function sessionAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[config.JWT_COOKIE_NAME];
  if (!token) {
    return next(new UnauthorizedError('Sign in required', 'NO_SESSION'));
  }
  try {
    const payload = verifySession(token);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    next(new UnauthorizedError('Session expired or invalid', 'INVALID_SESSION'));
  }
}

/**
 * Cookie options shared by login/signup/logout so they line up.
 *
 * In production the frontend (Vercel) and backend (Render) live on
 * different domains. Browsers will reject cross-origin cookies unless
 * `SameSite=None` AND `Secure` — which also requires HTTPS, satisfied by
 * both platforms by default.
 */
export function sessionCookieOptions(maxAgeMs?: number) {
  const isProd = config.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
    maxAge: maxAgeMs ?? 7 * 24 * 60 * 60 * 1000, // 7d default
  };
}
