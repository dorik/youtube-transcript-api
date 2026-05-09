import { z } from 'zod';

/**
 * Environment configuration. Loaded once at startup; throws if invalid.
 *
 * `STUB_*` flags toggle real vs. stub implementations of external services.
 * When true, the corresponding service uses a fake/canned response so we can
 * develop end-to-end without paying for / configuring third-party APIs.
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

  STUB_STRIPE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  STUB_WHISPER: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  STUB_PROXY: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  STUB_TRANSLATION: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ID_STARTER: z.string().optional(),
  STRIPE_PRICE_ID_PRO: z.string().optional(),
  STRIPE_PRICE_ID_BUSINESS: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  PROXY_URL: z.string().optional(),

  RATE_LIMIT_REQUESTS_PER_MIN: z.coerce.number().default(100),
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
