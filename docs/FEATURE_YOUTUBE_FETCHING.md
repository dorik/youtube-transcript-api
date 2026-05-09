# Feature: YouTube Transcript Fetching

**Status:** Not started  
**Priority:** Critical (Tier 1)  
**Est. Effort:** 2-3 days  
**Dependencies:** Proxy setup, YouTube account setup

---

## Overview

This feature fetches native captions/transcripts directly from YouTube for a given video. It is the primary data source for the service and handles both English and 100+ other languages that YouTube supports.

### Key Goals

1. Reliably fetch YouTube captions using `youtube-transcript-api` library
2. Route requests through residential proxies to avoid IP blocks
3. Handle multiple languages (auto-detect and on-demand)
4. Extract metadata (title, duration, channel)
5. Parse captions into clean segments with timestamps

---

## Technical Approach

### Library Choice

**Recommended:** `youtube-transcript-api` (Python/JavaScript)
- Lightweight, actively maintained
- No official API key required (uses YouTube's undocumented API)
- Returns captions as structured segments (start, duration, text)
- Supports language specification
- Handles language auto-detection

**Alternative:** YouTube Data API v3
- Official, stable, but requires quota (free tier: 10,000 units/day)
- Slower: requires 2+ API calls per video
- Language detection requires separate call
- **Use for:** Metadata only, fallback if youtube-transcript-api fails

### Proxy Strategy

**Why proxies?**
- YouTube detects and throttles excessive scraping from single IPs
- Residential proxies appear as real users (avoid bans)
- Rotation prevents individual proxy burnout

**Proxy provider:** Bright Data, Smartproxy, or Webshare
- Cost: $200-500/mo for low-volume use
- Setup: 1-2 hours, straightforward HTTP proxy configuration

**Rotation strategy:**
```
Request 1 → Proxy A
Request 2 → Proxy B
Request 3 → Proxy C
Request 4 → Proxy A (cycle)
```

**Fallback:** If proxy fails, retry with different proxy (up to 3 attempts)

---

## Implementation Plan

### Step 1: Proxy Setup

**Configuration:**
```env
# .env
PROXY_PROVIDER=bright_data  # or smartproxy, webshare
PROXY_HOST=proxy.provider.com
PROXY_PORT=8080
PROXY_USERNAME=your_username
PROXY_PASSWORD=your_password
PROXY_ROTATE=true
```

**Proxy pool:**
```typescript
class ProxyPool {
  private proxies: ProxyConfig[];
  private currentIndex: number = 0;

  constructor(config: ProxyConfig[]) {
    this.proxies = config;
  }

  getNext(): ProxyConfig {
    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    return proxy;
  }

  getByIndex(index: number): ProxyConfig {
    return this.proxies[index % this.proxies.length];
  }
}
```

**Test proxy connectivity:**
```typescript
async function testProxyConnection(proxy: ProxyConfig): Promise<boolean> {
  try {
    const response = await axios.get('https://api.ipify.org?format=json', {
      httpAgent: new HttpProxyAgent(`http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`),
      httpsAgent: new HttpsProxyAgent(`http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`),
      timeout: 5000,
    });
    console.log(`Proxy works, IP: ${response.data.ip}`);
    return true;
  } catch (error) {
    console.error(`Proxy failed: ${error.message}`);
    return false;
  }
}
```

### Step 2: Install youtube-transcript-api

**Node.js:**
```bash
npm install youtube-transcript-api
npm install -D @types/youtube-transcript-api
```

**Python:**
```bash
pip install youtube-transcript-api
```

### Step 3: Basic Fetcher Implementation

**Node.js (TypeScript):**

```typescript
// src/services/youtubeTranscriptFetcher.ts
import axios, { AxiosInstance } from 'axios';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { YoutubeTranscript } from 'youtube-transcript-api';

interface TranscriptSegment {
  start: number;      // Start time in seconds
  duration: number;   // Duration in seconds
  text: string;       // Transcript text
}

interface FetchResult {
  videoId: string;
  title: string;
  duration: number;
  channel: string;
  uploadDate: string;
  language: string;
  transcript: string; // Full text
  segments: TranscriptSegment[];
  source: 'native_captions';
}

class YouTubeTranscriptFetcher {
  private proxyPool: ProxyPool;
  private cache: Map<string, FetchResult> = new Map();

  constructor(proxyPool: ProxyPool) {
    this.proxyPool = proxyPool;
  }

  async fetch(videoId: string, language: string = 'auto'): Promise<FetchResult> {
    // Check cache
    const cacheKey = `${videoId}:${language}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    let lastError: Error | null = null;

    // Try up to 3 proxies
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const proxy = this.proxyPool.getNext();
        const result = await this.fetchWithProxy(videoId, language, proxy);
        this.cache.set(cacheKey, result);
        return result;
      } catch (error) {
        lastError = error as Error;
        console.warn(`Attempt ${attempt + 1} failed: ${lastError.message}`);
        // Continue to next proxy
      }
    }

    // All proxies failed
    throw new Error(`Failed to fetch transcript after 3 attempts: ${lastError?.message}`);
  }

  private async fetchWithProxy(
    videoId: string,
    language: string,
    proxy: ProxyConfig,
  ): Promise<FetchResult> {
    const agents = this.createProxyAgents(proxy);

    // Create axios instance with proxy
    const client = axios.create({
      httpAgent: agents.http,
      httpsAgent: agents.https,
      timeout: 10000,
    });

    try {
      // Fetch captions using youtube-transcript-api
      const captions = await YoutubeTranscript.fetchTranscript(videoId, {
        lang: language === 'auto' ? undefined : language,
        client,
      });

      // Parse captions into segments
      const segments = captions.map((caption: any) => ({
        start: caption.start,
        duration: caption.duration || 1, // Default 1 second if not provided
        text: caption.text,
      }));

      const fullText = segments.map((s: TranscriptSegment) => s.text).join(' ');

      // Fetch metadata (title, duration, channel)
      const metadata = await this.fetchMetadata(videoId, client);

      return {
        videoId,
        title: metadata.title,
        duration: metadata.duration,
        channel: metadata.channel,
        uploadDate: metadata.uploadDate,
        language: captions[0]?.language || language,
        transcript: fullText,
        segments,
        source: 'native_captions',
      };
    } catch (error) {
      if ((error as any).message.includes('No transcripts found')) {
        throw new NoTranscriptError('No captions available for this video');
      }
      throw error;
    }
  }

  private createProxyAgents(proxy: ProxyConfig) {
    const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
    return {
      http: new HttpProxyAgent(proxyUrl),
      https: new HttpsProxyAgent(proxyUrl),
    };
  }

  private async fetchMetadata(videoId: string, client: AxiosInstance) {
    // Option 1: Parse from YouTube page (simple, no API key needed)
    try {
      const response = await client.get(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });

      // Extract initial data from page
      const initialDataMatch = response.data.match(/var ytInitialData = ({.*?});/);
      if (initialDataMatch) {
        const data = JSON.parse(initialDataMatch[1]);
        const videoDetails = this.parseVideoDetails(data);
        return videoDetails;
      }
    } catch (error) {
      console.warn('Failed to fetch metadata from YouTube page, using fallback');
    }

    // Option 2: Return minimal metadata
    return {
      title: 'Unknown Title',
      duration: 0,
      channel: 'Unknown Channel',
      uploadDate: new Date().toISOString().split('T')[0],
    };
  }

  private parseVideoDetails(data: any) {
    // This is complex HTML parsing. For MVP, use a library like cheerio
    // or call YouTube Data API with API key for reliability
    // Simplified version below:
    try {
      const videoDetails = data.contents.twoColumnWatchNextResults.results.results.contents[0].videoPrimaryInfoRenderer;
      return {
        title: videoDetails.title.runs[0].text,
        duration: 0, // Would need additional parsing
        channel: videoDetails.subtitle.runs[2].text,
        uploadDate: new Date().toISOString().split('T')[0],
      };
    } catch {
      return {
        title: 'Unknown',
        duration: 0,
        channel: 'Unknown',
        uploadDate: new Date().toISOString().split('T')[0],
      };
    }
  }
}

export { YouTubeTranscriptFetcher, FetchResult, TranscriptSegment };
```

### Step 4: Handle Multiple Languages

**Language support:**
```typescript
const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  // ... 100+ more
];

async function fetchInLanguage(videoId: string, language: string): Promise<FetchResult> {
  if (!SUPPORTED_LANGUAGES.find(l => l.code === language)) {
    throw new Error(`Unsupported language: ${language}`);
  }

  return fetcher.fetch(videoId, language);
}

async function fetchWithAutoDetect(videoId: string): Promise<FetchResult> {
  // YouTube returns captions in the video's native language by default
  return fetcher.fetch(videoId, 'auto');
}

async function fetchAvailableLanguages(videoId: string): Promise<string[]> {
  // Get list of available language captions for a video
  const transcript = await YoutubeTranscript.getTranscript(videoId);
  return transcript.map(t => t.language);
}
```

### Step 5: Error Handling

**Common failure modes:**

```typescript
class NoTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoTranscriptError';
  }
}

class VideoNotFoundError extends Error {
  constructor(videoId: string) {
    super(`Video not found: ${videoId}`);
    this.name = 'VideoNotFoundError';
  }
}

class AgeRestrictedError extends Error {
  constructor(videoId: string) {
    super(`Video is age-restricted: ${videoId}`);
    this.name = 'AgeRestrictedError';
  }
}

class ProxyBlockedError extends Error {
  constructor(proxy: string) {
    super(`Proxy IP blocked by YouTube: ${proxy}`);
    this.name = 'ProxyBlockedError';
  }
}

// Usage
async function fetchWithErrorHandling(videoId: string, language: string) {
  try {
    return await fetcher.fetch(videoId, language);
  } catch (error) {
    if (error instanceof NoTranscriptError) {
      // Fall back to Whisper transcription
      return await whisperFallback.transcribe(videoId);
    }
    if (error instanceof AgeRestrictedError) {
      throw new Error('Video is age-restricted. Please verify your age on YouTube to access captions.');
    }
    if (error instanceof ProxyBlockedError) {
      // Notify admin, consider rotating proxy provider
      await notifyAdminOfProxyIssue(error);
      throw new Error('Service temporarily unavailable due to proxy issues. Please try again later.');
    }
    throw error;
  }
}
```

### Step 6: Metrics & Monitoring

```typescript
class YouTubeMetrics {
  static async trackFetch(videoId: string, language: string, success: boolean, source: string) {
    await db.query(
      `INSERT INTO youtube_fetch_metrics (video_id, language, success, source, timestamp)
       VALUES ($1, $2, $3, $4, NOW())`,
      [videoId, language, success, source]
    );
  }

  static async getSuccessRate(): Promise<number> {
    const result = await db.query(
      `SELECT 
        CAST(SUM(CASE WHEN success THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) * 100 as rate
       FROM youtube_fetch_metrics
       WHERE timestamp > NOW() - INTERVAL '24 hours'`
    );
    return result.rows[0].rate;
  }

  static async getLanguageDistribution() {
    const result = await db.query(
      `SELECT language, COUNT(*) as count
       FROM youtube_fetch_metrics
       WHERE timestamp > NOW() - INTERVAL '24 hours'
       GROUP BY language
       ORDER BY count DESC`
    );
    return result.rows;
  }
}
```

---

## Testing

### Unit Tests

```typescript
describe('YouTubeTranscriptFetcher', () => {
  let fetcher: YouTubeTranscriptFetcher;
  let proxyPool: ProxyPool;

  beforeEach(() => {
    proxyPool = new ProxyPool([
      { host: 'proxy1.com', port: 8080, username: 'user', password: 'pass' },
      { host: 'proxy2.com', port: 8080, username: 'user', password: 'pass' },
    ]);
    fetcher = new YouTubeTranscriptFetcher(proxyPool);
  });

  it('should fetch transcript for valid video', async () => {
    const result = await fetcher.fetch('dQw4w9WgXcQ', 'en');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.transcript).toBeDefined();
  });

  it('should return segments with correct structure', async () => {
    const result = await fetcher.fetch('dQw4w9WgXcQ', 'en');
    result.segments.forEach(segment => {
      expect(segment.start).toBeGreaterThanOrEqual(0);
      expect(segment.duration).toBeGreaterThan(0);
      expect(segment.text).toBeDefined();
    });
  });

  it('should throw NoTranscriptError for videos without captions', async () => {
    expect(async () => {
      await fetcher.fetch('video_without_captions', 'en');
    }).rejects.toThrow(NoTranscriptError);
  });

  it('should support multiple languages', async () => {
    const englishResult = await fetcher.fetch('multilingual_video', 'en');
    const spanishResult = await fetcher.fetch('multilingual_video', 'es');

    expect(englishResult.language).toBe('en');
    expect(spanishResult.language).toBe('es');
  });

  it('should rotate through proxies', async () => {
    const proxies = [
      { host: 'proxy1', port: 8080, username: 'user', password: 'pass' },
      { host: 'proxy2', port: 8080, username: 'user', password: 'pass' },
      { host: 'proxy3', port: 8080, username: 'user', password: 'pass' },
    ];
    const pool = new ProxyPool(proxies);

    expect(pool.getNext().host).toBe('proxy1');
    expect(pool.getNext().host).toBe('proxy2');
    expect(pool.getNext().host).toBe('proxy3');
    expect(pool.getNext().host).toBe('proxy1'); // Cycles back
  });
});
```

### Integration Tests

**Real YouTube videos to test:**

| Video | Conditions | Expected |
|-------|-----------|----------|
| `dQw4w9WgXcQ` | Popular, English, 213 sec | Should fetch quickly, ~10 segments |
| Rick Roll Spanish | Same video, Spanish captions | Should fetch in Spanish, language: 'es' |
| Tech talk | Non-English speaker, unclear audio | Language detection should work |
| Unlisted video | Private/unlisted | Should fail with clear error |
| Age-restricted | Age check required | Should fail gracefully |
| Deleted video | Removed from YouTube | Should fail with 404 |

---

## Deployment

### Pre-deployment Checklist

- [ ] Proxy provider account created and configured
- [ ] Proxy connectivity tested with all proxies
- [ ] youtube-transcript-api installed and tested
- [ ] Error handling covers all edge cases
- [ ] Metrics/monitoring in place
- [ ] Rate limits configured (don't hammer YouTube)
- [ ] Logging enabled for debugging

### Rate Limiting Strategy

Avoid YouTube banning our IP/proxies:
- Max 1 request per second per proxy
- Max 10 concurrent requests total
- Stagger requests to different proxies
- Monitor success rate; alert if < 95%

```typescript
class RateLimiter {
  private queue: Promise<any>[] = [];
  private maxConcurrent = 10;
  private minDelayMs = 100; // 100ms between requests

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    while (this.queue.length >= this.maxConcurrent) {
      await Promise.race(this.queue);
      this.queue = this.queue.filter(p => p.status !== 'fulfilled');
    }

    await new Promise(resolve => setTimeout(resolve, this.minDelayMs));

    const promise = fn();
    this.queue.push(promise);
    return promise;
  }
}
```

---

## Performance Goals

| Metric | Target |
|--------|--------|
| Avg fetch time (cached) | < 100ms |
| Avg fetch time (fresh native) | < 500ms |
| P95 fetch time (fresh native) | < 2 seconds |
| Success rate | > 95% |
| Whisper fallback trigger rate | < 10% (good caption coverage) |

---

## Future Improvements (Phase 2+)

- [ ] YouTube Data API v3 integration for better metadata
- [ ] Auto-transcription for damaged/incomplete captions
- [ ] Caching at segment level (not just full video)
- [ ] Multi-threaded fetching (fetch multiple videos in parallel)
- [ ] Smart proxy selection (choose fastest/most reliable proxy)

---

**Status:** Ready for implementation  
**Version:** 1.0  
**Last Updated:** 2026-05-09
