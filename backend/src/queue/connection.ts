import IORedis from 'ioredis';
import { config } from '../config/env';
import { logger } from '../config/logger';

/**
 * BullMQ requires its own ioredis connection with `maxRetriesPerRequest: null`
 * — it issues long-lived blocking commands and manages retries itself. The
 * cache client in src/cache/redis.ts keeps `maxRetriesPerRequest: 3`; the two
 * must NOT be shared.
 */
export const queueConnection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});

queueConnection.on('error', (err) => {
  logger.error({ err }, 'Queue Redis connection error');
});
