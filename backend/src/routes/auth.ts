import { Router } from 'express';
import { z } from 'zod';
import {
  createUser,
  getUserByEmail,
  getUserByIdRequired,
  recordLogin,
} from '../services/userService';
import { verifyPassword } from '../utils/password';
import {
  sessionAuth,
  sessionCookieOptions,
  signSession,
} from '../middleware/sessionAuth';
import { config } from '../config/env';
import { UnauthorizedError, ValidationError } from '../utils/errors';

export const authRouter = Router();

const SignupSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  display_name: z.string().min(1).max(255).optional(),
});

const LoginSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

authRouter.post('/signup', async (req, res, next) => {
  try {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid signup payload', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const { email, password, display_name } = parsed.data;
    const user = await createUser(email, password, display_name);

    const token = signSession({ sub: user.id, email: user.email });
    res.cookie(config.JWT_COOKIE_NAME, token, sessionCookieOptions());

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid login payload', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const { email, password } = parsed.data;
    const user = await getUserByEmail(email);
    if (!user) {
      // Same message as wrong-password to avoid user enumeration
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.is_suspended) {
      throw new UnauthorizedError('Account suspended', 'ACCOUNT_SUSPENDED');
    }

    await recordLogin(user.id);

    const token = signSession({ sub: user.id, email: user.email });
    res.cookie(config.JWT_COOKIE_NAME, token, sessionCookieOptions());
    res.json({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(config.JWT_COOKIE_NAME, sessionCookieOptions(0));
  res.json({ ok: true });
});

authRouter.get('/me', sessionAuth, async (req, res, next) => {
  try {
    const user = await getUserByIdRequired(req.user!.id);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        created_at: user.created_at,
        last_login_at: user.last_login_at,
      },
    });
  } catch (err) {
    next(err);
  }
});
