import Redis from 'ioredis';
import { config } from '../config/env';
import { logger } from '../config/logger';

export const redis = new Redis(config.REDIS_URL, {
  // Keep retries reasonable so a Redis outage fails fast in dev rather than
  // backing up the request queue.
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis client error');
});

redis.on('connect', () => {
  logger.info('Redis connected');
});
