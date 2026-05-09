# Feature: GET /v1/transcript API Endpoint

**Status:** Not started  
**Priority:** Critical (Tier 1)  
**Est. Effort:** 2-3 days  
**Dependencies:** YouTube fetching, output formatters, caching, authentication, database

---

## Overview

The core API endpoint accepts a YouTube video URL and returns a transcript in the user's requested format. This is the primary interface for users of the service.

### Endpoint Specification

```
GET /v1/transcript?url=<youtube_url>&format=<format>&language=<lang>

Headers:
  Authorization: Bearer <API_KEY>
  Content-Type: application/json

Query Parameters:
  url (required):     Full YouTube URL (e.g., https://www.youtube.com/watch?v=dQw4w9WgXcQ)
  format (optional):  json|text|text-timestamps|srt|vtt (default: json)
  language (optional): ISO 639-1 code (e.g., en, es, fr) or 'auto' (default: auto)
```

### Success Response (200 OK)

```json
{
  "video_id": "dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up (Official Video)",
  "duration": 213,
  "channel": "Rick Astley",
  "upload_date": "2009-10-25",
  "language": "en",
  "source": "native_captions",
  "transcript": "We're no strangers to love... [full text]",
  "segments": [
    {
      "start": 0.0,
      "duration": 2.4,
      "text": "We're no strangers to love"
    },
    {
      "start": 2.4,
      "duration": 3.1,
      "text": "You know the rules and so do I"
    }
  ],
  "credits_used": 1,
  "cached": false,
  "fetched_at": "2026-05-09T14:32:15Z"
}
```

**Response breakdown:**
- `video_id`: YouTube video ID extracted from URL
- `title`: Video title (fetched from YouTube metadata)
- `duration`: Video length in seconds
- `channel`: Channel name
- `upload_date`: ISO 8601 date
- `language`: Detected or requested language code
- `source`: "native_captions" or "whisper" (which source provided the transcript)
- `transcript`: Full transcript text (format-agnostic representation)
- `segments`: Array of timestamped segments (only in JSON format)
- `credits_used`: How many credits were deducted (1 for native, 1+ for Whisper)
- `cached`: Boolean indicating if this was a cache hit
- `fetched_at`: Timestamp of when transcript was fetched

### Error Responses

**400 Bad Request** — Invalid URL or missing required parameter
```json
{
  "error": "invalid_request",
  "message": "url parameter is required",
  "code": "MISSING_PARAMETER"
}
```

**401 Unauthorized** — Missing or invalid API key
```json
{
  "error": "unauthorized",
  "message": "Invalid or missing API key",
  "code": "INVALID_API_KEY"
}
```

**402 Payment Required** — Insufficient credits
```json
{
  "error": "insufficient_credits",
  "message": "You have 5 credits remaining. This request requires 10 credits (Whisper).",
  "code": "INSUFFICIENT_CREDITS",
  "credits_available": 5,
  "credits_required": 10
}
```

**404 Not Found** — Video not found or inaccessible
```json
{
  "error": "video_not_found",
  "message": "The video could not be found or is no longer available",
  "code": "VIDEO_NOT_FOUND"
}
```

**429 Too Many Requests** — Rate limited
```json
{
  "error": "rate_limited",
  "message": "You have exceeded your rate limit of 100 requests per minute",
  "code": "RATE_LIMIT_EXCEEDED",
  "retry_after": 30
}
```

**500 Internal Server Error** — Unexpected error (Whisper API down, etc.)
```json
{
  "error": "internal_error",
  "message": "An unexpected error occurred. Please try again later.",
  "code": "INTERNAL_ERROR",
  "request_id": "req_abc123xyz"
}
```

---

## Implementation Plan

### Step 1: URL Validation & Parsing
**Goal:** Extract video ID from various YouTube URL formats.

**Supported URL formats:**
```
https://www.youtube.com/watch?v=dQw4w9WgXcQ
https://youtu.be/dQw4w9WgXcQ
https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s
https://www.youtube.com/embed/dQw4w9WgXcQ
```

**Implementation:**
```typescript
function extractVideoId(url: string): string {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  throw new Error('Invalid YouTube URL');
}
```

### Step 2: Authentication & Authorization
**Goal:** Verify API key, fetch user record, check if account is active.

**Flow:**
1. Extract Bearer token from `Authorization` header
2. Query database: `SELECT users.*, api_keys.* FROM api_keys JOIN users ...`
3. Verify API key is valid and not revoked
4. Check user account status (active, suspended, deleted)
5. Return user object for credit deduction later

**Error cases:**
- Missing Authorization header → 401
- Invalid API key → 401
- User account suspended → 403
- User API key revoked → 401

### Step 3: Check Cache
**Goal:** Return instantly if transcript is already cached.

**Cache key:** `transcript:{video_id}:{language}`

**Flow:**
1. Query Redis with key `transcript:dQw4w9WgXcQ:en`
2. If cache hit, deserialize and return (mark `cached: true`)
3. If cache miss, proceed to fetch

**Cache TTL:** 30 days (transcripts don't change)

### Step 4: Fetch YouTube Metadata
**Goal:** Get title, duration, channel, upload date.

**Source:** youtube-transcript-api includes metadata, or separate metadata fetch via YouTube Data API (if quota available).

**Data needed:**
- Title
- Duration (seconds)
- Channel name
- Upload date
- Thumbnail URL (optional, for preview)

### Step 5: Fetch Transcript
**Goal:** Try native captions first, fall back to Whisper.

**Flow:**
```
1. Call YouTubeTranscriptFetcher.fetch(videoId, language)
2. If successful → store source: "native_captions"
3. If fails (no captions) → call WhisperFallback.transcribe(videoId, language)
4. If Whisper succeeds → store source: "whisper"
5. If both fail → return 404 or 500 error
```

This is handled by separate features (FEATURE_YOUTUBE_FETCHING, FEATURE_WHISPER_FALLBACK).

### Step 6: Detect Language
**Goal:** Auto-detect language from transcript or use requested language.

**Flow:**
1. If `language` parameter provided → use that
2. Else if native captions exist → use their language
3. Else if Whisper was used → Whisper returns detected language
4. Else default to 'en'

**Library:** textract/langdetect (Python) or langdetect (Node.js npm package)

### Step 7: Format Output
**Goal:** Convert transcript to requested format.

**Formats:**
- `json`: Segments with timestamps (default)
- `text`: Plain text only
- `text-timestamps`: Plain text with [HH:MM:SS] prefix per line
- `srt`: SubRip format
- `vtt`: WebVTT format

This is handled by separate feature (FEATURE_OUTPUT_FORMATS).

### Step 8: Deduct Credits
**Goal:** Deduct credits from user account based on source.

**Credit logic:**
- Native captions: 1 credit
- Whisper: 1 credit per minute of audio (rounded up)
  - Example: 10-minute video = 10 credits
  - Example: 3.5-minute video = 4 credits

**Flow:**
1. Check user's current credit balance
2. Determine credits needed (1 or calculated from duration)
3. If insufficient → return 402 error (don't fetch)
4. If sufficient → deduct and log transaction

**Database transaction:**
```sql
BEGIN;
  UPDATE user_accounts 
  SET credits_balance = credits_balance - $1 
  WHERE user_id = $2;
  
  INSERT INTO credit_transactions 
  (user_id, amount, reason, video_id, source) 
  VALUES ($2, -$1, 'transcript_fetch', $3, $4);
COMMIT;
```

### Step 9: Cache Result
**Goal:** Store transcript in Redis for future requests.

**Cache entry:**
```typescript
interface CachedTranscript {
  videoId: string;
  title: string;
  duration: number;
  language: string;
  source: 'native_captions' | 'whisper';
  transcript: string;
  segments: Array<{ start: number; duration: number; text: string }>;
  fetchedAt: string;
}
```

**Store in Redis:**
```typescript
const key = `transcript:${videoId}:${language}`;
const ttl = 30 * 24 * 60 * 60; // 30 days
await redis.setex(key, ttl, JSON.stringify(cachedTranscript));
```

### Step 10: Return Response
**Goal:** Format response based on requested format, include metadata.

**Response object:**
```typescript
interface TranscriptResponse {
  video_id: string;
  title: string;
  duration: number;
  channel: string;
  upload_date: string;
  language: string;
  source: 'native_captions' | 'whisper';
  transcript: string | string[] | SRTFormat | VTTFormat;
  segments: Segment[]; // Only in JSON format
  credits_used: number;
  cached: boolean;
  fetched_at: string;
}
```

**Format output:**
- If `format=json` → return full object with segments
- If `format=text` → return transcript (string) only
- If `format=text-timestamps` → return transcript with timestamps
- If `format=srt` → return SRT-formatted string
- If `format=vtt` → return VTT-formatted string

---

## Code Structure

### Express.js Handler (Node.js)

```typescript
// src/routes/transcript.ts
import express from 'express';
import { authenticateApiKey } from '../middleware/auth';
import { rateLimitMiddleware } from '../middleware/rateLimit';
import { transcriptService } from '../services/transcriptService';

const router = express.Router();

router.get(
  '/v1/transcript',
  authenticateApiKey,
  rateLimitMiddleware,
  async (req, res) => {
    try {
      const { url, format = 'json', language = 'auto' } = req.query;
      const userId = req.user.id;

      // Validate URL
      if (!url || typeof url !== 'string') {
        return res.status(400).json({
          error: 'invalid_request',
          message: 'url parameter is required and must be a string',
          code: 'MISSING_PARAMETER',
        });
      }

      // Validate format
      const validFormats = ['json', 'text', 'text-timestamps', 'srt', 'vtt'];
      if (!validFormats.includes(format as string)) {
        return res.status(400).json({
          error: 'invalid_request',
          message: `format must be one of: ${validFormats.join(', ')}`,
          code: 'INVALID_FORMAT',
        });
      }

      // Call service
      const result = await transcriptService.getTranscript(
        userId,
        url as string,
        format as string,
        language as string,
      );

      return res.status(200).json(result);
    } catch (error) {
      // Error handling delegated to middleware
      next(error);
    }
  },
);

export default router;
```

### Service Layer

```typescript
// src/services/transcriptService.ts
export class TranscriptService {
  async getTranscript(
    userId: string,
    url: string,
    format: string,
    language: string,
  ): Promise<TranscriptResponse> {
    // 1. Extract video ID
    const videoId = extractVideoId(url);

    // 2. Check cache
    const cached = await this.cacheService.get(`transcript:${videoId}:${language}`);
    if (cached) {
      // Format and return
      return this.formatResponse(cached, format, true);
    }

    // 3. Check user credits
    const user = await this.userService.getUser(userId);
    const creditsNeeded = await this.estimateCreditsNeeded(videoId);
    if (user.creditsBalance < creditsNeeded) {
      throw new PaymentRequiredError(
        creditsNeeded,
        user.creditsBalance,
      );
    }

    // 4. Fetch transcript
    const fetchResult = await this.fetcherService.fetch(videoId, language);

    // 5. Deduct credits
    await this.creditService.deductCredits(userId, creditsNeeded, videoId, fetchResult.source);

    // 6. Cache result
    await this.cacheService.set(`transcript:${videoId}:${language}`, fetchResult, { ttl: 30 * 24 * 60 * 60 });

    // 7. Format and return
    return this.formatResponse(fetchResult, format, false);
  }

  private formatResponse(data: any, format: string, fromCache: boolean): TranscriptResponse {
    const baseResponse = {
      video_id: data.videoId,
      title: data.title,
      duration: data.duration,
      channel: data.channel,
      upload_date: data.uploadDate,
      language: data.language,
      source: data.source,
      credits_used: data.creditsUsed,
      cached: fromCache,
      fetched_at: data.fetchedAt,
    };

    if (format === 'json') {
      return { ...baseResponse, transcript: data.transcript, segments: data.segments };
    }

    if (format === 'text') {
      return { ...baseResponse, transcript: data.transcript };
    }

    if (format === 'text-timestamps') {
      const withTimestamps = data.segments
        .map((seg: Segment) => `[${formatTime(seg.start)}] ${seg.text}`)
        .join('\n');
      return { ...baseResponse, transcript: withTimestamps };
    }

    if (format === 'srt') {
      const srtContent = formatToSRT(data.segments);
      return { ...baseResponse, transcript: srtContent };
    }

    if (format === 'vtt') {
      const vttContent = formatToVTT(data.segments);
      return { ...baseResponse, transcript: vttContent };
    }
  }
}
```

---

## Testing

### Unit Tests

```typescript
describe('GET /v1/transcript', () => {
  it('should return transcript for valid YouTube URL', async () => {
    const res = await request(app)
      .get('/v1/transcript')
      .set('Authorization', 'Bearer valid_key')
      .query({ url: 'https://youtu.be/abc123' });

    expect(res.status).toBe(200);
    expect(res.body.video_id).toBe('abc123');
    expect(res.body.transcript).toBeDefined();
  });

  it('should return 400 for missing url parameter', async () => {
    const res = await request(app)
      .get('/v1/transcript')
      .set('Authorization', 'Bearer valid_key');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PARAMETER');
  });

  it('should return 401 for invalid API key', async () => {
    const res = await request(app)
      .get('/v1/transcript')
      .set('Authorization', 'Bearer invalid_key')
      .query({ url: 'https://youtu.be/abc123' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_API_KEY');
  });

  it('should return 402 for insufficient credits', async () => {
    const res = await request(app)
      .get('/v1/transcript')
      .set('Authorization', 'Bearer valid_key_with_no_credits')
      .query({ url: 'https://youtu.be/abc123_whisper_video' });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
  });

  it('should return cached result with cached: true flag', async () => {
    // First request
    const res1 = await request(app)
      .get('/v1/transcript')
      .set('Authorization', 'Bearer valid_key')
      .query({ url: 'https://youtu.be/abc123' });

    expect(res1.body.cached).toBe(false);

    // Second request (should be cached)
    const res2 = await request(app)
      .get('/v1/transcript')
      .set('Authorization', 'Bearer valid_key')
      .query({ url: 'https://youtu.be/abc123' });

    expect(res2.body.cached).toBe(true);
  });

  it('should support all output formats', async () => {
    const formats = ['json', 'text', 'text-timestamps', 'srt', 'vtt'];

    for (const format of formats) {
      const res = await request(app)
        .get('/v1/transcript')
        .set('Authorization', 'Bearer valid_key')
        .query({ url: 'https://youtu.be/abc123', format });

      expect(res.status).toBe(200);
      expect(res.body.transcript).toBeDefined();
    }
  });
});
```

### Integration Tests

```typescript
describe('Transcript endpoint integration', () => {
  it('should handle real YouTube video and cache result', async () => {
    // Test on a real YouTube video
    // Verify transcript is returned
    // Verify credit deduction
    // Verify cache works
  });

  it('should handle video without captions (Whisper fallback)', async () => {
    // Test on a YouTube video with no captions
    // Verify Whisper is used
    // Verify correct credits deducted (duration-based)
  });

  it('should handle age-restricted video gracefully', async () => {
    // Test on an age-restricted video
    // Verify error message is clear
  });
});
```

---

## Deployment Checklist

- [ ] Endpoint deployed to production
- [ ] API key authentication verified with live data
- [ ] Caching tested (Redis operational)
- [ ] Rate limiting active
- [ ] Error handling covers all edge cases
- [ ] Monitoring/alerting in place (response times, error rates)
- [ ] Load tested (sub-100ms cached, sub-500ms fresh)
- [ ] Documentation updated with examples
- [ ] SDK code examples working

---

## Monitoring & Metrics

**Key metrics to track:**
- Request count (per user, per plan)
- Response latency (p50, p95, p99)
- Cache hit rate
- Credit deduction accuracy
- Error rate (by error code)
- Whisper fallback rate (indicates caption coverage)
- YouTube fetching success rate

**Alerts:**
- Error rate > 5%
- Response latency p95 > 1000ms
- Cache hit rate < 70%
- Whisper API failures

---

**Status:** Ready for implementation  
**Version:** 1.0  
**Last Updated:** 2026-05-09
