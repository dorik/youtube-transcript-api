import { z } from 'zod';

/**
 * Environment configuration. Loaded once at startup; throws if invalid.
 *
 * External services (Stripe, OpenAI/Whisper, translation, proxy) are always
 * real. The keys below are required for those features to function; absence
 * causes a hard failure at the call site rather than a fake response.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Comma-separated list of allowed frontend origins (no trailing slash).
  // Validated leniently so a list like "https://app.example.com,https://staging.example.com"
  // passes — individual entries are checked at CORS time.
  FRONTEND_URL: z.string().min(1).default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_COOKIE_NAME: z.string().default('yt_session'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ID_STARTER: z.string().optional(),
  STRIPE_PRICE_ID_PRO: z.string().optional(),
  STRIPE_PRICE_ID_BUSINESS: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  PROXY_URL: z.string().optional(),
  /**
   * Absolute path to a Netscape-format cookies file for yt-dlp. When YouTube
   * starts serving the bot challenge to our datacenter IP, this is the only
   * code-level lever that can unblock requests without changing egress.
   * Generate with `yt-dlp --cookies-from-browser <browser> --cookies <file>`
   * on a logged-in workstation, upload to the server, set this var.
   */
  YT_COOKIES_PATH: z.string().optional(),

  RATE_LIMIT_REQUESTS_PER_MIN: z.coerce.number().default(100),

  /**
   * How many transcript jobs the in-process BullMQ worker runs in parallel.
   * Kept low (2) because each job can spawn yt-dlp + ffmpeg + Whisper, which
   * is memory-heavy on the 512 MB Render instance.
   */
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),

  /**
   * Shared secret for `POST /flush-cache?secret=...`. When unset, that route
   * 404s — i.e. the endpoint is disabled unless a secret is explicitly
   * configured for the environment. Each environment (local/dev/prod) sets
   * its own value; the secret is never committed to source.
   */
  CACHE_FLUSH_SECRET: z.string().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:');
    // eslint-disable-next-line no-console
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
