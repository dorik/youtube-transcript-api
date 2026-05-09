# Feature: Whisper Fallback Transcription

**Status:** Not started  
**Priority:** Critical (Tier 1)  
**Est. Effort:** 2 days  
**Dependencies:** YouTube fetching, credit system, output formats

---

## Overview

This feature provides automatic transcription for YouTube videos that don't have native captions using OpenAI's Whisper API. When a user requests a transcript for a video without captions, the system automatically:

1. Downloads the video's audio
2. Sends it to Whisper API for transcription
3. Formats the result into segments with timestamps
4. Stores the transcript for future reuse
5. Deducts credits based on audio duration (1 credit per minute)

---

## Technical Approach

### Why Whisper?

**Whisper API advantages:**
- Multilingual (99+ languages)
- High accuracy (especially for English)
- Timestamps built-in
- Simple HTTP API (no setup needed)
- Costs predictable ($0.006/minute)

**Alternative: Self-hosted Whisper**
- For Phase 2+ (if volume justifies)
- Requires GPU infrastructure
- Lower variable cost at scale but higher fixed costs

**Decision:** Start with OpenAI Whisper API for MVP simplicity.

---

## Implementation Plan

### Step 1: Audio Extraction

**Goal:** Download audio from YouTube video.

**Library:** `yt-dlp` (actively maintained, fast)

**Installation:**
```bash
npm install yt-dlp  # Node.js wrapper
# OR
pip install yt-dlp  # Python
```

**Implementation:**

```typescript
// src/services/audioExtractor.ts
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface ExtractedAudio {
  filePath: string;
  durationSeconds: number;
  format: 'mp3' | 'wav';
}

export async function extractAudioFromYouTube(
  videoId: string,
  outputDir: string = '/tmp/youtube-audio'
): Promise<ExtractedAudio> {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(outputDir, `${videoId}.%(ext)s`);

  try {
    // Use yt-dlp to extract audio in mp3 format
    const { stdout } = await execFileAsync('yt-dlp', [
      '-f', 'bestaudio[ext=m4a]/bestaudio',  // Get best audio
      '-x',                                    // Extract audio
      '--audio-format', 'mp3',                 // Convert to MP3
      '--audio-quality', '192K',              // Quality (balance between size and quality)
      '-o', outputPath,
      videoUrl,
    ], {
      timeout: 120000,  // 2 minute timeout
    });

    const audioFile = `${outputPath.split('.')[0]}.mp3`;

    // Get audio duration
    const { stdout: durationOutput } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1:noprint_filename=1',
      audioFile,
    ]);

    const durationSeconds = Math.ceil(parseFloat(durationOutput.trim()));

    return {
      filePath: audioFile,
      durationSeconds,
      format: 'mp3',
    };
  } catch (error) {
    console.error(`Failed to extract audio for video ${videoId}:`, error);
    throw new Error(`Audio extraction failed: ${error.message}`);
  }
}

// Cleanup temp file
export async function cleanupAudioFile(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.warn(`Failed to cleanup audio file ${filePath}:`, error);
  }
}
```

**Dependencies:**
- `yt-dlp`: For audio extraction
- `ffprobe`: For getting duration (comes with FFmpeg)

**Installation:**
```bash
# macOS
brew install yt-dlp ffmpeg

# Ubuntu/Debian
sudo apt-get install yt-dlp ffmpeg

# Or use Docker image with both pre-installed
```

### Step 2: Audio File Size Validation

**Goal:** Check file size before sending to Whisper API.

```typescript
export function validateAudioFile(filePath: string, maxSizeMb: number = 25): boolean {
  const stats = fs.statSync(filePath);
  const fileSizeMb = stats.size / (1024 * 1024);

  if (fileSizeMb > maxSizeMb) {
    throw new Error(
      `Audio file is too large (${fileSizeMb.toFixed(2)}MB). ` +
      `Maximum is ${maxSizeMb}MB. Video may be too long or poor quality.`
    );
  }

  return true;
}
```

**Whisper API limit:** 25 MB per request

### Step 3: Whisper API Integration

**Goal:** Send audio to Whisper and receive transcript.

**Setup:**
```bash
npm install openai
```

**Configuration:**
```env
OPENAI_API_KEY=sk_test_...
WHISPER_MODEL=whisper-1
```

**Implementation:**

```typescript
// src/services/whisperService.ts
import * as fs from 'fs';
import OpenAI from 'openai';

interface WhisperResult {
  text: string;
  language: string;
  duration: number;
}

interface WhisperSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function transcribeWithWhisper(
  audioFilePath: string,
  language?: string
): Promise<WhisperResult> {
  try {
    // Read audio file
    const audioBuffer = fs.readFileSync(audioFilePath);

    // Call Whisper API
    const response = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' }),
      model: 'whisper-1',
      language: language,  // Optional: specify language for better accuracy
      response_format: 'json',  // Get full response with language detection
    });

    return {
      text: response.text,
      language: response.language || 'en',
      duration: 0,  // Would need to track separately
    };
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      console.error(`Whisper API error (${error.status}): ${error.message}`);
      throw new Error(`Transcription failed: ${error.message}`);
    }
    throw error;
  }
}

// For verbose output with segments and timestamps
export async function transcribeWithWhisperVerbose(
  audioFilePath: string,
  language?: string
): Promise<{ text: string; segments: WhisperSegment[] }> {
  try {
    const audioBuffer = fs.readFileSync(audioFilePath);

    // Note: verbose_json response format available with raw API call
    const response = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' }),
      model: 'whisper-1',
      language: language,
      response_format: 'verbose_json',
    } as any);  // Type hack for verbose_json option

    return {
      text: response.text,
      segments: (response as any).segments || [],
    };
  } catch (error) {
    console.error('Whisper verbose transcription error:', error);
    throw error;
  }
}
```

### Step 4: Segment Parsing & Cleanup

**Goal:** Convert Whisper output to clean segments with timestamps.

```typescript
// src/services/segmentParser.ts
interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

export function parseWhisperSegments(whisperSegments: WhisperSegment[]): TranscriptSegment[] {
  return whisperSegments.map(seg => ({
    start: seg.start,
    duration: seg.end - seg.start,
    text: seg.text.trim(),
  }));
}

// If verbose response not available, create fake segments from text
export function createSegmentsFromText(text: string, durationSeconds: number): TranscriptSegment[] {
  const words = text.split(' ');
  const wordsPerSecond = words.length / durationSeconds;
  const segmentWords = Math.max(5, Math.floor(wordsPerSecond * 5));  // ~5 seconds per segment

  const segments: TranscriptSegment[] = [];
  let currentTime = 0;

  for (let i = 0; i < words.length; i += segmentWords) {
    const segmentWordArray = words.slice(i, i + segmentWords);
    const segmentText = segmentWordArray.join(' ');

    segments.push({
      start: currentTime,
      duration: (segmentWordArray.length / wordsPerSecond),
      text: segmentText,
    });

    currentTime += segmentWordArray.length / wordsPerSecond;
  }

  return segments;
}
```

### Step 5: Whisper Fallback Service

**Goal:** Orchestrate the full fallback flow.

```typescript
// src/services/whisperFallback.ts
import { extractAudioFromYouTube, cleanupAudioFile, validateAudioFile } from './audioExtractor';
import { transcribeWithWhisperVerbose } from './whisperService';
import { parseWhisperSegments, createSegmentsFromText } from './segmentParser';

interface WhisperFallbackResult {
  videoId: string;
  transcript: string;
  segments: TranscriptSegment[];
  language: string;
  durationSeconds: number;
  creditsRequired: number;
  source: 'whisper';
}

export async function transcribeWithWhisperFallback(
  videoId: string,
  metadata: { title: string; duration: number; channel: string }
): Promise<WhisperFallbackResult> {
  let audioFilePath: string | null = null;

  try {
    console.log(`[Whisper] Starting fallback transcription for video ${videoId}`);

    // 1. Extract audio
    const extractionStart = Date.now();
    const { filePath, durationSeconds } = await extractAudioFromYouTube(videoId);
    audioFilePath = filePath;
    console.log(`[Whisper] Audio extracted (${durationSeconds}s) in ${Date.now() - extractionStart}ms`);

    // 2. Validate file size
    validateAudioFile(filePath);

    // 3. Transcribe
    const transcriptionStart = Date.now();
    const whisperResult = await transcribeWithWhisperVerbose(filePath);
    console.log(`[Whisper] Transcription completed in ${Date.now() - transcriptionStart}ms`);

    // 4. Parse segments
    const segments = whisperResult.segments?.length > 0
      ? parseWhisperSegments(whisperResult.segments)
      : createSegmentsFromText(whisperResult.text, durationSeconds);

    // 5. Calculate credits
    const creditsRequired = Math.ceil(durationSeconds / 60);

    return {
      videoId,
      transcript: whisperResult.text,
      segments,
      language: 'en',  // Whisper response should include language
      durationSeconds,
      creditsRequired,
      source: 'whisper',
    };
  } catch (error) {
    console.error(`[Whisper] Fallback failed for video ${videoId}:`, error);
    throw new Error(`Whisper transcription failed: ${error.message}`);
  } finally {
    // 6. Cleanup temp file
    if (audioFilePath) {
      await cleanupAudioFile(audioFilePath);
    }
  }
}
```

### Step 6: Cost Calculation

**Goal:** Ensure credit costs match Whisper API costs.

```typescript
export function calculateWhisperCredits(durationSeconds: number): number {
  // Whisper: $0.006 per minute
  // Our credit system: 1 credit per minute (free users get 100 credits = $0.60 value)
  
  // So: 1 credit = $0.006
  // For transparency: 1 credit per minute of audio
  
  const minutes = Math.ceil(durationSeconds / 60);
  return minutes;
}

export function estimateWhisperCost(durationSeconds: number): number {
  // For billing/revenue tracking
  const minutes = durationSeconds / 60;
  return minutes * 0.006;  // $0.006 per minute
}
```

**Pricing math:**
- Video duration: 10 minutes
- Credits charged: 10 credits
- Our cost from Whisper: 10 × $0.006 = $0.06
- Revenue (Pro user): Has 12,000 credits/month = $29/month ÷ 12,000 = $0.0024 per credit
- Profit margin: $0.0024 - $0.006 = **-$0.0036 per credit** 🔴 (we lose money on Whisper)

**Note:** Whisper fallback is a feature, not a profit center. The value is in the subscription tier, not individual transcripts.

### Step 7: Monitoring & Metrics

```typescript
// src/services/metrics.ts
export async function trackWhisperUsage(
  videoId: string,
  durationSeconds: number,
  success: boolean
) {
  await db.query(
    `INSERT INTO whisper_metrics (video_id, duration_seconds, success, timestamp)
     VALUES ($1, $2, $3, NOW())`,
    [videoId, durationSeconds, success]
  );
}

export async function getWhisperStats(): Promise<{
  total_videos_transcribed: number;
  total_minutes: number;
  estimated_cost: number;
  success_rate: number;
  avg_duration_minutes: number;
}> {
  const result = await db.query(`
    SELECT 
      COUNT(*) as total_videos,
      SUM(duration_seconds) as total_seconds,
      COUNT(CASE WHEN success THEN 1 END) * 100.0 / COUNT(*) as success_rate,
      AVG(duration_seconds) as avg_duration
    FROM whisper_metrics
    WHERE timestamp > NOW() - INTERVAL '30 days'
  `);

  const row = result.rows[0];
  const totalMinutes = Math.ceil((row.total_seconds || 0) / 60);

  return {
    total_videos_transcribed: row.total_videos || 0,
    total_minutes: totalMinutes,
    estimated_cost: totalMinutes * 0.006,
    success_rate: parseFloat(row.success_rate) || 0,
    avg_duration_minutes: Math.ceil((row.avg_duration || 0) / 60),
  };
}
```

---

## Error Handling

**Common failures:**

```typescript
class AudioExtractionError extends Error {}
class WhisperAPIError extends Error {}
class AudioTooLargeError extends Error {}
class VideoTooLongError extends Error {}

export async function transcribeWithErrorHandling(
  videoId: string,
  metadata: any
): Promise<WhisperFallbackResult> {
  try {
    return await transcribeWithWhisperFallback(videoId, metadata);
  } catch (error) {
    if (error instanceof AudioExtractionError) {
      throw new Error(
        `Could not extract audio from this video. It may be age-restricted or geographically restricted.`
      );
    }

    if (error instanceof AudioTooLargeError) {
      throw new Error(
        `Video is too long or has very high bitrate audio. Maximum supported: 25MB.`
      );
    }

    if (error instanceof WhisperAPIError) {
      // Transient error, can retry
      throw new Error(
        `Transcription service temporarily unavailable. Please try again in a few minutes.`
      );
    }

    throw error;
  }
}
```

---

## Testing

### Unit Tests

```typescript
describe('Whisper Fallback', () => {
  it('should extract audio from YouTube', async () => {
    const result = await extractAudioFromYouTube('dQw4w9WgXcQ');
    expect(result.filePath).toBeDefined();
    expect(result.durationSeconds).toBeGreaterThan(0);
  });

  it('should transcribe audio with Whisper', async () => {
    const result = await transcribeWithWhisper('./test-audio.mp3');
    expect(result.text).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('should calculate correct credits for duration', () => {
    expect(calculateWhisperCredits(60)).toBe(1);
    expect(calculateWhisperCredits(90)).toBe(2);
    expect(calculateWhisperCredits(30)).toBe(1);
  });

  it('should handle audio extraction failures', async () => {
    expect(async () => {
      await transcribeWithWhisperFallback('invalid_video_id', {});
    }).rejects.toThrow();
  });
});
```

### Integration Tests

```typescript
describe('Whisper Fallback Integration', () => {
  it('should complete end-to-end Whisper transcription', async () => {
    // Use a real YouTube video without captions
    const result = await transcribeWithWhisperFallback('video_no_captions', {
      title: 'Test Video',
      duration: 120,
      channel: 'Test Channel',
    });

    expect(result.transcript).toBeDefined();
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.source).toBe('whisper');
    expect(result.creditsRequired).toBe(2); // 120 seconds = 2 credits
  });
});
```

---

## Performance Goals

| Metric | Target |
|--------|--------|
| Audio extraction | < 30 seconds (for 10-min video) |
| Whisper transcription | < 30 seconds (for 10-min video) |
| Total fallback time | < 60 seconds |
| Success rate | > 95% |
| Whisper cost per video | < $0.10 (10 min video) |

---

## Deployment Checklist

- [ ] OpenAI API key obtained and configured
- [ ] yt-dlp and FFmpeg installed on server
- [ ] Test Whisper API call with real audio
- [ ] Credit calculation verified
- [ ] Error handling covers all edge cases
- [ ] Audio cleanup working (no disk bloat)
- [ ] Whisper metrics tracking enabled
- [ ] Rate limiting considered (don't overload Whisper)

---

## Future Improvements (Phase 2+)

- [ ] Self-hosted Whisper for cost reduction
- [ ] Parallel transcription for multiple videos
- [ ] Audio preprocessing (noise reduction, normalization)
- [ ] Language-specific Whisper models
- [ ] Caching of audio files for common videos

---

**Status:** Ready for implementation  
**Version:** 1.0  
**Last Updated:** 2026-05-09
