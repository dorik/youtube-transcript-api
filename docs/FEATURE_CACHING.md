# Feature: Redis Caching Layer

**Status:** Not started  
**Priority:** Critical (Tier 1)  
**Est. Effort:** 1-2 days  
**Dependencies:** Database schema, API endpoint, Redis server

---

## Overview

This feature implements a two-level caching strategy using Redis for fast transcript retrieval:

1. **Hot cache (Redis):** In-memory cache for frequently accessed transcripts (sub-100ms response)
2. **Cold cache (Postgres):** Database cache for all transcripts (backup + audit trail)

### Goals

- **Latency:** < 100ms for cached requests
- **Hit rate:** > 85% for popular videos
- **Cost savings:** Reduce YouTube fetches by 80%+
- **Scalability:** Handle 10,000+ requests/day without hitting YouTube rate limits

---

## Architecture

### Cache Flow

```
Request for video X
  ↓
Check Redis cache key: transcript:videoId:language
  ├─ Cache HIT → Return instantly (< 100ms)
  ├─ Cache MISS → 
      ↓
      Check Postgres cold cache
        ├─ Hit → Deserialize, return (< 500ms)
        ├─ Miss →
            ↓
            Fetch from YouTube/Whisper
            ↓
            Store in Redis (hot cache)
            ↓
            Store in Postgres (cold cache)
            ↓
            Return to user
```

---

## Implementation Plan

### Step 1: Redis Setup

**Installation:**

```bash
# macOS
brew install redis

# Ubuntu/Debian
sudo apt-get install redis-server

# Docker
docker run -d -p 6379:6379 redis:latest
```

**Configuration:**

```env
# .env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_password_optional
REDIS_DB=0
REDIS_URL=redis://localhost:6379/0
```

**Client setup (Node.js):**

```bash
npm install redis
```

**Client initialization:**

```typescript
// src/services/cache.ts
import { createClient } from 'redis';

const redisClient = createClient({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB) || 0,
});

redisClient.on('error', (err) => console.error('Redis error:', err));
redisClient.on('connect', () => console.log('Redis connected'));

export { redisClient };
```

### Step 2: Cache Key Strategy

**Key format:** `{namespace}:{video_id}:{language}`

```typescript
export function getCacheKey(videoId: string, language: string = 'en'): string {
  return `transcript:${videoId}:${language}`;
}

export function getMetadataCacheKey(videoId: string): string {
  return `metadata:${videoId}`;
}

export function getRateLimitKey(userId: string): string {
  return `ratelimit:${userId}`;
}

export function getCacheStatsKey(): string {
  return `cache:stats`;
}
```

### Step 3: Cache Service

**Goal:** Centralized cache operations with fallback to database.

```typescript
// src/services/cacheService.ts
import { redisClient } from './redis';
import { db } from '../db';

interface CachedTranscript {
  videoId: string;
  title: string;
  duration: number;
  language: string;
  transcript: string;
  segments: Array<{ start: number; duration: number; text: string }>;
  source: 'native_captions' | 'whisper';
  fetchedAt: string;
}

export class CacheService {
  /**
   * Get transcript from cache (Redis first, then Postgres)
   */
  async get(videoId: string, language: string = 'en'): Promise<CachedTranscript | null> {
    const key = getCacheKey(videoId, language);

    try {
      // Try Redis
      const cachedData = await redisClient.get(key);
      if (cachedData) {
        // Track cache hit
        await this.trackHit(key);
        return JSON.parse(cachedData);
      }
    } catch (error) {
      console.warn('Redis get error:', error);
      // Fall through to database
    }

    // Try Postgres
    try {
      const result = await db.query(
        `SELECT * FROM cached_transcripts 
         WHERE video_id = $1 AND language = $2 AND expires_at > NOW()`,
        [videoId, language]
      );

      if (result.rows.length > 0) {
        const transcript = result.rows[0];
        
        // Repopulate Redis (warm the cache)
        this.set(videoId, language, transcript).catch(err =>
          console.warn('Failed to repopulate Redis:', err)
        );

        return transcript;
      }
    } catch (error) {
      console.error('Postgres cache get error:', error);
    }

    return null;
  }

  /**
   * Store transcript in both Redis and Postgres
   */
  async set(
    videoId: string,
    language: string,
    transcript: CachedTranscript,
    ttlSeconds: number = 30 * 24 * 60 * 60  // 30 days
  ): Promise<void> {
    const key = getCacheKey(videoId, language);
    const data = JSON.stringify(transcript);

    try {
      // Store in Redis with TTL
      await redisClient.setex(key, ttlSeconds, data);
    } catch (error) {
      console.error('Redis set error:', error);
    }

    try {
      // Store in Postgres
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      await db.query(
        `INSERT INTO cached_transcripts 
         (video_id, language, title, duration, channel, upload_date, source, transcript_text, segments, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (video_id, language) DO UPDATE SET
           last_accessed_at = NOW(),
           access_count = access_count + 1`,
        [
          videoId,
          language,
          transcript.title,
          transcript.duration,
          transcript.channel || 'Unknown',
          transcript.uploadDate || new Date().toISOString().split('T')[0],
          transcript.source,
          transcript.transcript,
          JSON.stringify(transcript.segments),
          expiresAt,
        ]
      );
    } catch (error) {
      console.error('Postgres cache set error:', error);
    }
  }

  /**
   * Delete from cache
   */
  async delete(videoId: string, language: string = 'en'): Promise<void> {
    const key = getCacheKey(videoId, language);

    try {
      await redisClient.del(key);
    } catch (error) {
      console.warn('Redis delete error:', error);
    }

    try {
      await db.query(
        'DELETE FROM cached_transcripts WHERE video_id = $1 AND language = $2',
        [videoId, language]
      );
    } catch (error) {
      console.warn('Postgres delete error:', error);
    }
  }

  /**
   * Track cache statistics
   */
  private async trackHit(key: string): Promise<void> {
    try {
      // Increment hit counter
      await redisClient.incr(`${key}:hits`);
      
      // Also track globally
      await redisClient.incr('cache:total_hits');
    } catch (error) {
      console.warn('Failed to track cache hit:', error);
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    hits: number;
    misses: number;
    hitRate: number;
    redisSize: string;
  }> {
    try {
      const info = await redisClient.info('stats');
      const hits = parseInt(info.keyspace_hits) || 0;
      const misses = parseInt(info.keyspace_misses) || 0;
      const total = hits + misses;
      const hitRate = total > 0 ? (hits / total * 100).toFixed(2) : '0';

      return {
        hits,
        misses,
        hitRate: parseFloat(hitRate),
        redisSize: info.used_memory_human || 'unknown',
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return { hits: 0, misses: 0, hitRate: 0, redisSize: 'unknown' };
    }
  }
}

export const cacheService = new CacheService();
```

### Step 4: Integrate with API Endpoint

**Usage in transcript endpoint:**

```typescript
// src/routes/transcript.ts
router.get('/v1/transcript', authenticateApiKey, async (req, res, next) => {
  try {
    const { url, format = 'json', language = 'auto' } = req.query;
    const userId = req.user.id;

    // Validate URL
    const videoId = extractVideoId(url);

    // Check cache FIRST
    const cached = await cacheService.get(videoId, language);
    if (cached) {
      return res.json({
        ...cached,
        cached: true,
        creditsUsed: 0,  // No credits for cached requests
        fetchedAt: cached.fetchedAt,
      });
    }

    // Cache miss - continue with fetching
    const result = await transcriptService.getTranscript(userId, url, format, language);
    
    // Store in cache for next time
    await cacheService.set(videoId, language, result);

    res.json(result);
  } catch (error) {
    next(error);
  }
});
```

### Step 5: Cache Invalidation Strategy

**When to invalidate:**

```typescript
// Manual invalidation (admin endpoint)
router.delete('/admin/cache/:videoId', authenticateAdmin, async (req, res) => {
  const { videoId } = req.params;
  await cacheService.delete(videoId);
  res.json({ message: 'Cache invalidated' });
});

// Auto-invalidation on update (if metadata changes)
export async function invalidateIfMetadataChanged(videoId: string) {
  const cached = await cacheService.get(videoId);
  if (!cached) return;

  const fresh = await youtubeService.getMetadata(videoId);
  if (cached.title !== fresh.title || cached.duration !== fresh.duration) {
    await cacheService.delete(videoId);
  }
}

// TTL-based invalidation (30 days, automatic via Redis/Postgres)
```

### Step 6: Cleanup Expired Entries

**Scheduled job (daily):**

```typescript
// src/jobs/cacheCleanup.ts
import cron from 'node-cron';

export function scheduleCleanup() {
  // Run at 2 AM daily
  cron.schedule('0 2 * * *', async () => {
    try {
      console.log('[Cache Cleanup] Starting...');

      // Delete expired entries from Postgres
      const result = await db.query(
        `DELETE FROM cached_transcripts 
         WHERE expires_at < NOW()`
      );

      console.log(`[Cache Cleanup] Deleted ${result.rowCount} expired entries from Postgres`);

      // Redis automatically expires entries via TTL
      const stats = await redisClient.info('stats');
      console.log(`[Cache Cleanup] Redis expired: ${stats.expired_keys} keys`);
    } catch (error) {
      console.error('[Cache Cleanup] Error:', error);
    }
  });
}
```

### Step 7: Monitoring & Metrics

```typescript
// src/services/cacheMetrics.ts
export async function trackCacheMetrics() {
  const stats = await cacheService.getStats();

  // Store in database for tracking over time
  await db.query(
    `INSERT INTO system_metrics (metric_name, metric_value, metadata)
     VALUES 
       ('cache_hit_rate', $1, $2),
       ('cache_total_hits', $3, NULL)`,
    [stats.hitRate, JSON.stringify({ redis_size: stats.redisSize }), stats.hits]
  );
}

export async function getCacheHealthcheck(): Promise<{
  redisAlive: boolean;
  hitRate: number;
  size: string;
  warning: string | null;
}> {
  const stats = await cacheService.getStats();

  let warning = null;
  if (stats.hitRate < 60) {
    warning = 'Cache hit rate is low (< 60%). Consider investigating.';
  }

  return {
    redisAlive: true,
    hitRate: stats.hitRate,
    size: stats.redisSize,
    warning,
  };
}
```

---

## Performance Optimization

### Redis Configuration

**Optimize memory usage:**

```redis
# redis.conf
maxmemory 512mb                    # Limit memory to 512MB
maxmemory-policy allkeys-lru       # Evict least recently used keys
```

### Connection Pooling

**Reuse connections:**

```typescript
// Use connection pool instead of new connections per request
const pool = redis.createPool({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  maxConnections: 10,
  idleTimeout: 30000,
});

export { pool };
```

### Batch Operations

**Optimize multiple reads/writes:**

```typescript
export async function batchSet(items: Array<[string, string, string]>) {
  // Use Redis pipeline for atomic batch writes
  const pipeline = redisClient.pipeline();

  for (const [videoId, language, data] of items) {
    const key = getCacheKey(videoId, language);
    pipeline.setex(key, 30 * 24 * 60 * 60, data);
  }

  await pipeline.exec();
}
```

---

## Testing

### Unit Tests

```typescript
describe('Cache Service', () => {
  it('should store and retrieve from cache', async () => {
    const transcript = { videoId: 'abc123', transcript: 'Test transcript' };
    await cacheService.set('abc123', 'en', transcript);

    const result = await cacheService.get('abc123', 'en');
    expect(result).toEqual(transcript);
  });

  it('should return null for missing keys', async () => {
    const result = await cacheService.get('nonexistent', 'en');
    expect(result).toBeNull();
  });

  it('should delete from cache', async () => {
    const transcript = { videoId: 'abc123', transcript: 'Test' };
    await cacheService.set('abc123', 'en', transcript);
    
    await cacheService.delete('abc123', 'en');
    const result = await cacheService.get('abc123', 'en');
    
    expect(result).toBeNull();
  });

  it('should track cache hits', async () => {
    const transcript = { videoId: 'abc123', transcript: 'Test' };
    await cacheService.set('abc123', 'en', transcript);

    await cacheService.get('abc123', 'en');
    const stats = await cacheService.getStats();

    expect(stats.hits).toBeGreaterThan(0);
  });

  it('should expire old entries', async () => {
    const transcript = { videoId: 'abc123', transcript: 'Test' };
    await cacheService.set('abc123', 'en', transcript, 1); // 1 second TTL

    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 1100));

    const result = await cacheService.get('abc123', 'en');
    expect(result).toBeNull();
  });
});
```

### Load Testing

```typescript
// Simulate cache hit scenario
async function loadTest(concurrentRequests = 100) {
  const promises = [];

  for (let i = 0; i < concurrentRequests; i++) {
    promises.push(cacheService.get('popular_video', 'en'));
  }

  const start = Date.now();
  await Promise.all(promises);
  const duration = Date.now() - start;

  console.log(`Served ${concurrentRequests} requests in ${duration}ms`);
  console.log(`Average: ${(duration / concurrentRequests).toFixed(2)}ms per request`);
}
```

---

## Monitoring & Alerts

**Key metrics:**
- Cache hit rate (target > 80%)
- Average response time (target < 100ms)
- Redis memory usage
- Expired keys count
- Evicted keys count

**Alerting:**
```
Hit rate < 60% → Investigate cache effectiveness
Response time p95 > 200ms → Cache may be struggling
Memory usage > 90% → Scale Redis or adjust TTL
```

---

## Deployment Checklist

- [ ] Redis installed and running
- [ ] Redis persistence configured (RDB snapshots)
- [ ] Memory limits and eviction policy set
- [ ] Connection pooling configured
- [ ] Cache service integrated with API
- [ ] Cleanup job scheduled
- [ ] Monitoring enabled
- [ ] Load testing completed (target < 100ms)
- [ ] Production Redis provider (Redis Cloud, AWS ElastiCache) configured

---

## Production Recommendations

**Managed Redis services:**
- **Redis Cloud:** Fully managed, auto-scaling
- **AWS ElastiCache:** Integrated with AWS
- **Heroku Redis:** Simple for smaller projects
- **DigitalOcean Managed Databases:** Good value

**Configuration for production:**
```
appendonly yes              # Enable AOF persistence
appendfsync everysec        # Balance safety and performance
save 900 1                  # Snapshot every 15 min if 1+ changes
```

---

**Status:** Ready for implementation  
**Version:** 1.0  
**Last Updated:** 2026-05-09
