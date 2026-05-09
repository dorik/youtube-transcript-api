import { Router } from 'express';
import { pool } from '../db/pool';
import { redis } from '../cache/redis';

export const healthRouter = Router();

/**
 * Health check. Reports DB and Redis status; HTTP 200 if both up, 503 if any
 * down. Useful for k8s/Render-style liveness probes.
 */
healthRouter.get('/', async (_req, res) => {
  const [db, cache] = await Promise.all([checkDb(), checkRedis()]);
  const allOk = db.status === 'ok' && cache.status === 'ok';
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    db,
    redis: cache,
    uptime_seconds: Math.round(process.uptime()),
  });
});

async function checkDb(): Promise<{ status: 'ok' | 'error'; error?: string }> {
  try {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}

async function checkRedis(): Promise<{ status: 'ok' | 'error'; error?: string }> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG' ? { status: 'ok' } : { status: 'error', error: 'unexpected response' };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}
