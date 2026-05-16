import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { config } from './config/env';
import { logger } from './config/logger';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { apiKeysRouter } from './routes/apiKeys';
import { transcriptRouter } from './routes/transcript';
import { meTranscriptRouter } from './routes/meTranscript';
import { meTranscriptsRouter } from './routes/meTranscripts';
import { billingRouter } from './routes/billing';
import { webhooksRouter } from './routes/webhooks';
import { usageRouter } from './routes/usage';
import { youtubeBrowseRouter } from './routes/youtubeBrowse';
import { adminRouter } from './routes/admin';
import { flushCacheRouter } from './routes/flushCache';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

/**
 * Compose the Express application.
 *
 * Order matters:
 *   1. CORS / cookies / logger / body parsers
 *   2. Routes
 *   3. 404 fallback
 *   4. Error handler (last)
 */
export function createApp(): Application {
  const app = express();

  // Render (and other PaaS) terminate TLS at a proxy in front of us. Tell
  // Express to trust the X-Forwarded-* headers so req.secure / req.ip work
  // correctly and Secure cookies actually flow.
  app.set('trust proxy', 1);

  // FRONTEND_URL accepts a comma-separated list so the same backend can
  // serve a Vercel preview deploy AND the production domain. Origins not
  // in the list are rejected.
  //
  // The special value `*` (alone or as one of the comma-separated entries)
  // opens the allowlist to any origin. The CORS spec forbids the literal
  // `Access-Control-Allow-Origin: *` header alongside credentials, so we
  // reflect the request's Origin instead — same permissive effect,
  // browser-compatible with our cookie auth. Use this as a temporary
  // unblocker while frontend domains are still moving; flip back to an
  // explicit list once they're stable.
  const frontendEntries = config.FRONTEND_URL
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAllOrigins = frontendEntries.includes('*');
  const allowedOrigins = frontendEntries.filter((o) => o !== '*');
  app.use(
    cors({
      credentials: true,
      origin(origin, cb) {
        // Same-origin requests (server-to-server, curl, health checks) have
        // no Origin header — allow them so /health and direct curl work.
        if (!origin) return cb(null, true);
        if (allowAllOrigins) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS: origin ${origin} not allowed`));
      },
    }),
  );
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  // JSON parsing for all routes EXCEPT Stripe webhooks. The webhook route
  // mounts express.raw() locally before the JSON parser sees the body.
  app.use((req, res, next) => {
    if (req.path === '/webhooks/stripe') return next();
    express.json({ limit: '1mb' })(req, res, next);
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'YouTube Transcripts API',
      version: '0.1.0',
      docs: '/docs',
      health: '/health',
    });
  });

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/me/api-keys', apiKeysRouter);
  app.use('/me/usage', usageRouter);
  app.use('/me/transcript', meTranscriptRouter);
  app.use('/me/transcripts', meTranscriptsRouter);
  app.use('/v1', transcriptRouter);
  app.use('/v1', youtubeBrowseRouter);
  app.use('/billing', billingRouter); // /billing/plans, /billing/subscription, /billing/checkout, /billing/change-plan
  app.use('/webhooks', webhooksRouter);
  app.use('/admin', adminRouter); // Operator-only; gated by ADMIN_TOKEN env. 404s when env is unset.
  app.use('/flush-cache', flushCacheRouter); // Query-secret cache wipe; 404s when CACHE_FLUSH_SECRET is unset.

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
