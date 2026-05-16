# Public Bulk Transcript API & Playground Playlist/Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a queue-backed `POST /v1/transcripts/bulk` + `GET /v1/transcripts/batches/:id` to the public API and restore the playground's Playlist/Channel tabs on the async enqueue-and-poll model.

**Architecture:** A shared `expandBulkSource` helper resolves a playlist/channel/URL-list into a video list; the dashboard route and the new public route both call it, then reuse the existing `enqueueBatch`. The playground submits the bulk POST, receives the expanded videos as queued entries, and polls the batch endpoint until every entry settles.

**Tech Stack:** Node.js, Express, TypeScript, Zod, Vitest (backend); Next.js 14, React 18, TanStack Query v5, shadcn/ui (frontend).

**Spec:** `docs/superpowers/specs/2026-05-16-public-bulk-transcript-api-design.md`

---

## File Structure

**Create:**
- `backend/src/services/bulkExpansion.ts` — `expandBulkSource()`: resolve a playlist/channel/URL-list into `BatchVideoInput[]`.
- `backend/src/services/bulkExpansion.test.ts` — unit tests for `expandBulkSource`.

**Modify:**
- `backend/src/routes/meTranscripts.ts` — refactor `POST /bulk` to call `expandBulkSource`.
- `backend/src/routes/transcript.ts` — add `POST /v1/transcripts/bulk` and `GET /v1/transcripts/batches/:id`.
- `frontend/src/features/playground/utils.ts` — multi-mode curl preview.
- `frontend/src/features/playground/PlaygroundClient.tsx` — restore Videos/Playlist/Channel tabs, add `runBulk`.
- `docs/superpowers/specs/2026-05-16-async-transcript-queue-design.md` — note the new `/v1` bulk endpoints.

---

## Task 1: Bulk-expansion helper

**Files:**
- Create: `backend/src/services/bulkExpansion.ts`
- Test: `backend/src/services/bulkExpansion.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/bulkExpansion.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expandBulkSource } from './bulkExpansion';
import * as browse from './youtubeBrowseService';

vi.mock('./youtubeBrowseService');

const sampleVideo = {
  video_id: 'abc12345678',
  url: 'https://youtu.be/abc12345678',
  title: 'Sample',
  channel: 'Chan',
  channel_id: 'UC1',
  duration_text: '10:00',
  published_text: null,
  view_count_text: null,
  thumbnail_url: 'https://img/abc.jpg',
};

describe('expandBulkSource', () => {
  beforeEach(() => vi.clearAllMocks());

  it('expands a playlist and maps videos to BatchVideoInput', async () => {
    vi.mocked(browse.listPlaylistVideos).mockResolvedValue({
      playlist_id: 'PL1',
      items: [sampleVideo],
    });
    const r = await expandBulkSource({ playlist: 'PL1', limit: 5 });
    expect(r.kind).toBe('playlist');
    expect(r.sourceUrl).toBe('PL1');
    expect(r.label).toBe('PL1');
    expect(r.videos).toEqual([
      {
        url: sampleVideo.url,
        video_id: sampleVideo.video_id,
        title: 'Sample',
        channel: 'Chan',
        thumbnail_url: sampleVideo.thumbnail_url,
      },
    ]);
    expect(browse.listPlaylistVideos).toHaveBeenCalledWith({
      playlist: 'PL1',
      limit: 5,
    });
  });

  it('expands a channel in videos mode with no query', async () => {
    vi.mocked(browse.listChannelVideos).mockResolvedValue({
      channel: 'Chan',
      items: [sampleVideo],
    });
    const r = await expandBulkSource({
      channel: '@chan',
      channelMode: 'videos',
      limit: 3,
    });
    expect(r.kind).toBe('channel');
    expect(browse.listChannelVideos).toHaveBeenCalledWith({
      channel: '@chan',
      query: undefined,
      limit: 3,
    });
  });

  it('passes the query through for channel search mode', async () => {
    vi.mocked(browse.listChannelVideos).mockResolvedValue({
      channel: 'Chan',
      items: [],
    });
    await expandBulkSource({
      channel: '@chan',
      channelMode: 'search',
      channelQuery: 'review',
      limit: 3,
    });
    expect(browse.listChannelVideos).toHaveBeenCalledWith({
      channel: '@chan',
      query: 'review',
      limit: 3,
    });
  });

  it('expands a urls list and extracts video ids', async () => {
    const r = await expandBulkSource({
      urls: ['https://youtu.be/abc12345678'],
      limit: 50,
    });
    expect(r.kind).toBe('videos');
    expect(r.sourceUrl).toBeNull();
    expect(r.videos[0].video_id).toBe('abc12345678');
  });

  it('throws ValidationError for a bad url', async () => {
    await expect(
      expandBulkSource({ urls: ['not a url'], limit: 50 }),
    ).rejects.toThrow(/Invalid URL at index 0/);
  });

  it('throws when no source is provided', async () => {
    await expect(expandBulkSource({ limit: 50 })).rejects.toThrow(
      /exactly one of/,
    );
  });

  it('throws when expansion exceeds the 100-video cap', async () => {
    const many = Array.from({ length: 101 }, () => sampleVideo);
    vi.mocked(browse.listPlaylistVideos).mockResolvedValue({
      playlist_id: 'PL1',
      items: many,
    });
    await expect(
      expandBulkSource({ playlist: 'PL1', limit: 100 }),
    ).rejects.toThrow(/limit/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `backend/`: `npx vitest run src/services/bulkExpansion.test.ts`
Expected: FAIL — `bulkExpansion.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/bulkExpansion.ts`:

```ts
import { listPlaylistVideos, listChannelVideos } from './youtubeBrowseService';
import type { BrowseVideo } from './youtubeBrowseService';
import { extractVideoId } from '../utils/youtubeUrl';
import { ValidationError } from '../utils/errors';
import { BATCH_VIDEO_CAP } from './transcriptRequestService';
import type { BatchVideoInput } from './transcriptRequestService';

/** Channel expansion modes. `videos`/`latest` list the channel's uploads;
 *  `search` runs a keyword search within the channel. */
export type ChannelMode = 'videos' | 'latest' | 'search';

export interface BulkExpansionInput {
  playlist?: string;
  channel?: string;
  channelMode?: ChannelMode;
  channelQuery?: string;
  urls?: string[];
  limit: number;
}

export interface BulkExpansionResult {
  kind: 'playlist' | 'channel' | 'videos';
  sourceUrl: string | null;
  label: string | null;
  videos: BatchVideoInput[];
}

function toBatchVideo(v: BrowseVideo): BatchVideoInput {
  return {
    url: v.url,
    video_id: v.video_id,
    title: v.title,
    channel: v.channel,
    thumbnail_url: v.thumbnail_url,
  };
}

function assertWithinCap(count: number): void {
  if (count > BATCH_VIDEO_CAP) {
    throw new ValidationError(
      `Batch exceeds the ${BATCH_VIDEO_CAP}-video limit (${count} videos).`,
    );
  }
}

/**
 * Resolve a bulk request's source (playlist / channel / explicit URLs) into a
 * video list ready for `enqueueBatch`. Throws `ValidationError` for a bad URL,
 * an over-cap result, or a missing source. `videos`/`latest` both list the
 * channel's uploads (the browse service treats them identically); `search`
 * adds the keyword query.
 */
export async function expandBulkSource(
  input: BulkExpansionInput,
): Promise<BulkExpansionResult> {
  if (input.playlist) {
    const listing = await listPlaylistVideos({
      playlist: input.playlist,
      limit: input.limit,
    });
    const videos = listing.items.map(toBatchVideo);
    assertWithinCap(videos.length);
    return {
      kind: 'playlist',
      sourceUrl: input.playlist,
      label: input.playlist,
      videos,
    };
  }

  if (input.channel) {
    const query =
      input.channelMode === 'search' ? input.channelQuery : undefined;
    const listing = await listChannelVideos({
      channel: input.channel,
      query,
      limit: input.limit,
    });
    const videos = listing.items.map(toBatchVideo);
    assertWithinCap(videos.length);
    return {
      kind: 'channel',
      sourceUrl: input.channel,
      label: input.channel,
      videos,
    };
  }

  if (input.urls && input.urls.length > 0) {
    const videos = input.urls.map((url, index) => {
      try {
        return { url, video_id: extractVideoId(url) };
      } catch {
        throw new ValidationError(`Invalid URL at index ${index}: ${url}`);
      }
    });
    assertWithinCap(videos.length);
    return { kind: 'videos', sourceUrl: null, label: null, videos };
  }

  throw new ValidationError('Provide exactly one of: playlist, channel, urls');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `backend/`: `npx vitest run src/services/bulkExpansion.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Verify typecheck**

Run from `backend/`: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/bulkExpansion.ts backend/src/services/bulkExpansion.test.ts
git commit -m "feat(queue): add shared bulk-expansion helper"
```

---

## Task 2: Refactor the dashboard bulk route to use the helper

**Files:**
- Modify: `backend/src/routes/meTranscripts.ts`

This removes the duplicated expansion logic from the dashboard `POST /me/transcripts/bulk` handler. Behaviour is unchanged — the dashboard does not send `channelMode`, so `expandBulkSource` defaults a channel to its uploads, exactly as today.

- [ ] **Step 1: Replace the inline expansion with the helper**

In `backend/src/routes/meTranscripts.ts`:

1. Replace the import block

```ts
import {
  listPlaylistVideos,
  listChannelVideos,
} from '../services/youtubeBrowseService';
import { extractVideoId } from '../utils/youtubeUrl';
```

with

```ts
import { expandBulkSource } from '../services/bulkExpansion';
```

2. Replace the body of the `POST /bulk` handler — everything from `const data = parsed.data;` down to (but not including) the `res.status(202).json(result);` line — with:

```ts
    const data = parsed.data;
    const { kind, sourceUrl, label, videos } = await expandBulkSource({
      playlist: data.playlist,
      channel: data.channel,
      urls: data.urls,
      limit: data.limit,
    });
    const result = await svc.enqueueBatch({
      userId: req.user!.id,
      kind,
      sourceUrl,
      label,
      videos,
      config: {
        format: data.format,
        language: data.language,
        native_only: data.native_only,
        translate_to: data.translate_to,
      },
    });
```

The `BulkSchema` definition and the `safeParse` validation block above it are unchanged.

- [ ] **Step 2: Verify typecheck**

Run from `backend/`: `npm run typecheck`
Expected: no errors. If the compiler flags `listPlaylistVideos`/`listChannelVideos`/`extractVideoId` as unused, confirm you removed their import line.

- [ ] **Step 3: Run the test suite**

Run from `backend/`: `npm test`
Expected: all tests PASS — no regression.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/meTranscripts.ts
git commit -m "refactor(queue): dashboard bulk route uses shared expansion helper"
```

---

## Task 3: Public bulk enqueue route — `POST /v1/transcripts/bulk`

**Files:**
- Modify: `backend/src/routes/transcript.ts`

- [ ] **Step 1: Add the import**

In `backend/src/routes/transcript.ts`, after the existing `import * as svc from '../services/transcriptRequestService';` line, add:

```ts
import { expandBulkSource } from '../services/bulkExpansion';
```

- [ ] **Step 2: Add the bulk schema and route**

In `backend/src/routes/transcript.ts`, after the existing `GET /transcript/:id` handler, add:

```ts
const BulkSchema = z
  .object({
    playlist: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    channelMode: z.enum(['videos', 'latest', 'search']).default('videos'),
    channelQuery: z.string().min(1).optional(),
    urls: z
      .array(z.string().min(1))
      .min(1)
      .max(svc.BATCH_VIDEO_CAP)
      .optional(),
    format: z
      .enum(VALID_FORMATS as [OutputFormat, ...OutputFormat[]])
      .default('json'),
    language: z.string().min(2).max(10).optional(),
    native_only: z.boolean().optional(),
    translate_to: z.string().min(2).max(10).optional(),
    limit: z.coerce.number().int().min(1).max(svc.BATCH_VIDEO_CAP).default(50),
  })
  .superRefine((val, ctx) => {
    const sourceCount =
      (val.playlist ? 1 : 0) +
      (val.channel ? 1 : 0) +
      (val.urls && val.urls.length > 0 ? 1 : 0);
    if (sourceCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exactly one of: playlist, channel, urls',
      });
    }
    if (val.channel && val.channelMode === 'search' && !val.channelQuery?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channelQuery is required when channelMode is "search"',
      });
    }
  });

/**
 * POST /v1/transcripts/bulk — public, API-key-authed bulk enqueue. Expands a
 * playlist/channel/URL-list, queues one job per video, and returns 202 with
 * the batch and its queued entries. Async-only: transcripts are polled via
 * GET /v1/transcripts/batches/:id.
 */
transcriptRouter.post(
  '/transcripts/bulk',
  apiKeyAuth,
  rateLimit,
  async (req, res, next) => {
    try {
      const parsed = BulkSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', {
          issues: parsed.error.flatten().fieldErrors,
        });
      }
      const data = parsed.data;
      const { kind, sourceUrl, label, videos } = await expandBulkSource({
        playlist: data.playlist,
        channel: data.channel,
        channelMode: data.channelMode,
        channelQuery: data.channelQuery,
        urls: data.urls,
        limit: data.limit,
      });
      const result = await svc.enqueueBatch({
        userId: req.user!.id,
        kind,
        sourceUrl,
        label,
        videos,
        config: {
          format: data.format,
          language: data.language,
          native_only: data.native_only,
          translate_to: data.translate_to,
        },
      });
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 3: Verify typecheck**

Run from `backend/`: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Start the server (`npm run dev`). With a valid API key:

```bash
curl -i -X POST http://localhost:3001/v1/transcripts/bulk \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer yt_live_...' \
  -d '{"playlist":"https://www.youtube.com/playlist?list=PL...","limit":3}'
```

Expected: `202` with `{ batch, requests }`; `requests` has up to 3 `queued` entries.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/transcript.ts
git commit -m "feat(queue): add POST /v1/transcripts/bulk public bulk enqueue"
```

---

## Task 4: Public batch poll route — `GET /v1/transcripts/batches/:id`

**Files:**
- Modify: `backend/src/routes/transcript.ts`

- [ ] **Step 1: Add the route**

In `backend/src/routes/transcript.ts`, after the `POST /transcripts/bulk` handler from Task 3, add:

```ts
/**
 * GET /v1/transcripts/batches/:id — poll a batch's summary, derived progress
 * counts, and entries. User-scoped to the API key's owner.
 */
transcriptRouter.get(
  '/transcripts/batches/:id',
  apiKeyAuth,
  rateLimit,
  async (req, res, next) => {
    try {
      const batch = await svc.getBatch(req.params.id, req.user!.id);
      if (!batch) {
        throw new NotFoundError('Batch not found');
      }
      const [progress, requests] = await Promise.all([
        svc.getBatchProgress(batch.id),
        svc.listBatchRequests(batch.id),
      ]);
      res.json({ batch, progress, requests });
    } catch (err) {
      next(err);
    }
  },
);
```

Both new routes live under the literal `transcripts` (plural) path; the existing `/transcript/:id` is a different segment, so there is no Express param-route collision.

- [ ] **Step 2: Verify typecheck**

Run from `backend/`: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verification**

With the server running and a batch id from Task 3's manual check:

```bash
curl -s http://localhost:3001/v1/transcripts/batches/<batch-id> \
  -H 'Authorization: Bearer yt_live_...'
```

Expected: `{ batch, progress, requests }`; `progress` counts move from `queued` toward `completed` over time. A bogus id returns `404`.

- [ ] **Step 4: Run the full test suite**

Run from `backend/`: `npm run typecheck && npm test`
Expected: no type errors; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/transcript.ts
git commit -m "feat(queue): add GET /v1/transcripts/batches/:id batch poll"
```

---

## Task 5: Playground curl preview — multi-mode

**Files:**
- Modify: `frontend/src/features/playground/utils.ts`

**Testing note:** the frontend has no automated test setup — verify with `npm run type-check` and `npm run lint` only.

- [ ] **Step 1: Rewrite `utils.ts`**

Overwrite `frontend/src/features/playground/utils.ts` with:

```ts
import { API_BASE_URL } from '@/lib/api';
import type { Format } from './types';

export function parseVideoLines(text: string): Array<{ url: string }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((url) => ({ url }));
}

export function shortVideoId(url: string): string {
  const m =
    url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ??
    url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ??
    url.match(/\/embed\/([a-zA-Z0-9_-]{11})/) ??
    url.match(/^([a-zA-Z0-9_-]{11})$/);
  return m ? m[1] : url.slice(0, 14) + (url.length > 14 ? '…' : '');
}

interface TranscriptOpts {
  format: Format;
  language: string;
  nativeOnly: boolean;
  translateTo: string;
  bearerPlaintext: string | null;
}

/** Curl-preview input — one variant per playground tab. */
export type CurlPreviewInput = (
  | { mode: 'video'; firstUrl: string | null }
  | { mode: 'playlist'; playlist: string; limit: number }
  | {
      mode: 'channel';
      channel: string;
      channelMode: 'videos' | 'latest' | 'search';
      channelQuery: string;
      limit: number;
    }
) &
  TranscriptOpts;

function bearerHeader(bearerPlaintext: string | null): string {
  const keyPlaceholder = bearerPlaintext
    ? `${bearerPlaintext.slice(0, 12)}...`
    : 'yt_live_YOUR_KEY';
  return `  -H 'Authorization: Bearer ${keyPlaceholder}'`;
}

/** Add the shared transcript options to a request body, omitting defaults. */
function withTranscriptOpts(
  body: Record<string, unknown>,
  opts: TranscriptOpts,
): Record<string, unknown> {
  if (opts.format !== 'json') body.format = opts.format;
  if (opts.language !== 'auto') body.language = opts.language;
  if (opts.nativeOnly) body.native_only = true;
  if (opts.translateTo !== 'none') body.translate_to = opts.translateTo;
  return body;
}

function curl(path: string, body: Record<string, unknown>, bearer: string | null): string {
  return [
    `curl -X POST '${API_BASE_URL}${path}' \\`,
    bearerHeader(bearer) + ` \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${JSON.stringify(body)}'`,
  ].join('\n');
}

/**
 * Build the curl snippet for the active tab. The Videos tab hits
 * POST /v1/transcript; the Playlist/Channel tabs hit POST /v1/transcripts/bulk
 * (which returns queued entries the caller then polls).
 */
export function buildCurlPreview(input: CurlPreviewInput): string {
  if (input.mode === 'video') {
    const body = withTranscriptOpts(
      { url: input.firstUrl ?? '<URL>' },
      input,
    );
    return curl('/v1/transcript', body, input.bearerPlaintext);
  }
  if (input.mode === 'playlist') {
    const body = withTranscriptOpts(
      { playlist: input.playlist || '<PLAYLIST_URL>', limit: input.limit },
      input,
    );
    return curl('/v1/transcripts/bulk', body, input.bearerPlaintext);
  }
  const body: Record<string, unknown> = {
    channel: input.channel || '<CHANNEL_URL>',
    channelMode: input.channelMode,
    limit: input.limit,
  };
  if (input.channelMode === 'search') {
    body.channelQuery = input.channelQuery || '<QUERY>';
  }
  return curl('/v1/transcripts/bulk', withTranscriptOpts(body, input), input.bearerPlaintext);
}
```

- [ ] **Step 2: Verify typecheck**

Run from `frontend/`: `npm run type-check`
Expected: errors only in `PlaygroundClient.tsx` (it still passes the old single-variant `CurlPreviewInput` and is rewritten in Task 6). No errors inside `utils.ts`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/playground/utils.ts
git commit -m "feat(playground): multi-mode curl preview for bulk tabs"
```

---

## Task 6: Playground — restore Videos/Playlist/Channel tabs

**Files:**
- Modify: `frontend/src/features/playground/PlaygroundClient.tsx`

This task reworks `PlaygroundClient.tsx`. Read the current file in full first — the steps below add to it surgically. The current file already has: the `runOne` helper, the Videos-only form, the `selectedPlaintext`/`authMode` derivations, the `onSubmit` per-video loop, `handleCopyPreview`, and the results panel. Keep all of that; the changes below add the Playlist/Channel tabs and bulk submit alongside it.

- [ ] **Step 1: Add imports**

Ensure these are imported at the top of `PlaygroundClient.tsx` (add any missing):

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  TranscriptRequest,
  BatchCreateResponse,
  BatchDetailResponse,
} from '@/lib/api';
```

(`Select*` and `Textarea` are already imported; `TranscriptRequest` is already imported — extend that import rather than duplicating.)

- [ ] **Step 2: Add the `runBulk` module-level helper**

Directly below the existing `runOne` function (still at module level, before `export function PlaygroundClient`), add:

```tsx
/**
 * Enqueue a playlist/channel/URL-list batch via POST /v1/transcripts/bulk, then
 * poll GET /v1/transcripts/batches/:id until every entry reaches a terminal
 * status. Returns the final request list.
 */
async function runBulk(
  bearer: string,
  body: Record<string, unknown>,
): Promise<TranscriptRequest[]> {
  const created = await api<BatchCreateResponse>('/v1/transcripts/bulk', {
    method: 'POST',
    body,
    bearer,
  });
  const batchId = created.batch.id;
  let requests = created.requests;
  while (
    requests.some((r) => r.status === 'queued' || r.status === 'processing')
  ) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    const detail = await api<BatchDetailResponse>(
      `/v1/transcripts/batches/${batchId}`,
      { bearer },
    );
    requests = detail.requests;
  }
  return requests;
}
```

- [ ] **Step 3: Add tab state**

Inside `PlaygroundClient`, with the other `useState` calls, add:

```tsx
  const [tab, setTab] = useState<'videos' | 'playlist' | 'channel'>('videos');
  const [playlistInput, setPlaylistInput] = useState('');
  const [channelInput, setChannelInput] = useState('');
  const [channelQuery, setChannelQuery] = useState('');
  const [channelMode, setChannelMode] = useState<
    'videos' | 'latest' | 'search'
  >('latest');
  const [browseLimit, setBrowseLimit] = useState(5);
```

- [ ] **Step 4: Replace the Videos-only input with the tabbed input**

Find the form's video-input block — the `<Label htmlFor="urls">` plus its `<Textarea id="urls" ...>` and the "{videoList.length} video(s) detected" line. Replace that whole block with:

```tsx
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList className="w-full grid grid-cols-3">
              <TabsTrigger value="videos">Videos</TabsTrigger>
              <TabsTrigger value="playlist">Playlist</TabsTrigger>
              <TabsTrigger value="channel">Channel</TabsTrigger>
            </TabsList>

            <TabsContent value="videos" className="mt-3 space-y-2">
              <Label htmlFor="urls">
                YouTube video URLs or IDs (one per line)
              </Label>
              <Textarea
                id="urls"
                rows={5}
                placeholder={
                  'https://youtu.be/dQw4w9WgXcQ\nhttps://www.youtube.com/watch?v=...'
                }
                value={videosText}
                onChange={(e) => setVideosText(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {videoList.length} video{videoList.length === 1 ? '' : 's'}{' '}
                detected
              </p>
            </TabsContent>

            <TabsContent value="playlist" className="mt-3 space-y-2">
              <Label htmlFor="playlist">Playlist URL or ID</Label>
              <Input
                id="playlist"
                placeholder="https://www.youtube.com/playlist?list=..."
                value={playlistInput}
                onChange={(e) => setPlaylistInput(e.target.value)}
              />
            </TabsContent>

            <TabsContent value="channel" className="mt-3 space-y-3">
              <div className="space-y-2">
                <Label htmlFor="channel">Channel URL, ID, or handle</Label>
                <Input
                  id="channel"
                  placeholder="@mkbhd or https://www.youtube.com/@mkbhd"
                  value={channelInput}
                  onChange={(e) => setChannelInput(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Channel mode</Label>
                <Select
                  value={channelMode}
                  onValueChange={(v) =>
                    setChannelMode(v as typeof channelMode)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="latest">Latest uploads</SelectItem>
                    <SelectItem value="videos">All videos</SelectItem>
                    <SelectItem value="search">Search in channel</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {channelMode === 'search' && (
                <div className="space-y-2">
                  <Label htmlFor="channel-query">Search query</Label>
                  <Input
                    id="channel-query"
                    placeholder="interview, tutorial, launch..."
                    value={channelQuery}
                    onChange={(e) => setChannelQuery(e.target.value)}
                  />
                </div>
              )}
            </TabsContent>
          </Tabs>

          {tab !== 'videos' && (
            <div className="grid gap-3 sm:grid-cols-[1fr_96px] sm:items-end">
              <p className="text-xs text-muted-foreground">
                Expands the playlist/channel on the server, queues a transcript
                per video, then polls until each finishes.
              </p>
              <div className="space-y-1">
                <Label htmlFor="browse-limit" className="text-xs">
                  Limit
                </Label>
                <Input
                  id="browse-limit"
                  type="number"
                  min={1}
                  max={25}
                  value={browseLimit}
                  onChange={(e) =>
                    setBrowseLimit(
                      Math.min(25, Math.max(1, Number(e.target.value) || 1)),
                    )
                  }
                />
              </div>
            </div>
          )}
```

- [ ] **Step 5: Add the shared transcript-options builder**

Inside the component, just above the existing `onSubmit`, add this helper (a plain function — it is only called from `onSubmit`, not passed as a prop):

```tsx
  function sharedOptions(): Record<string, unknown> {
    return {
      format,
      language: language === 'auto' ? undefined : language,
      native_only: nativeOnly || undefined,
      translate_to: translateTo === 'none' ? undefined : translateTo,
    };
  }
```

- [ ] **Step 6: Rewrite `onSubmit` to branch on the active tab**

Replace the entire existing `onSubmit` `useCallback` with:

```tsx
  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!selectedPlaintext) {
        toast.error(
          'A plaintext API key is required. Paste one or pick a key created in this browser.',
        );
        return;
      }

      // Map a settled TranscriptRequest to a result row.
      const toEntry = (r: TranscriptRequest): BulkResultEntry =>
        r.status === 'completed' && r.result
          ? {
              url: r.request.url,
              ok: true,
              data: r.result,
              requestId: r.id,
            }
          : {
              url: r.request.url,
              ok: false,
              error: r.error_message ?? 'Request failed',
            };

      setSubmitting(true);
      setResults([]);
      setActiveResultIdx(0);

      try {
        if (tab === 'videos') {
          if (videoList.length === 0) {
            toast.error('Add at least one YouTube URL or video ID.');
            setSubmitting(false);
            return;
          }
          const acc: BulkResultEntry[] = [];
          for (const v of videoList) {
            try {
              const current = await runOne(selectedPlaintext, {
                url: v.url,
                ...sharedOptions(),
              });
              acc.push(toEntry(current));
            } catch (err) {
              acc.push({
                url: v.url,
                ok: false,
                error: getApiErrorMessage(err, 'Request failed'),
              });
            }
            setResults([...acc]);
          }
          return;
        }

        // Playlist / channel: one bulk POST, then poll the batch.
        let body: Record<string, unknown>;
        if (tab === 'playlist') {
          if (!playlistInput.trim()) {
            toast.error('Paste a playlist URL or ID.');
            setSubmitting(false);
            return;
          }
          body = {
            playlist: playlistInput.trim(),
            limit: browseLimit,
            ...sharedOptions(),
          };
        } else {
          if (!channelInput.trim()) {
            toast.error('Paste a channel URL, ID, or handle.');
            setSubmitting(false);
            return;
          }
          if (channelMode === 'search' && !channelQuery.trim()) {
            toast.error('Enter a search query for channel search mode.');
            setSubmitting(false);
            return;
          }
          body = {
            channel: channelInput.trim(),
            channelMode,
            limit: browseLimit,
            ...(channelMode === 'search'
              ? { channelQuery: channelQuery.trim() }
              : {}),
            ...sharedOptions(),
          };
        }
        try {
          const requests = await runBulk(selectedPlaintext, body);
          setResults(requests.map(toEntry));
        } catch (err) {
          toast.error(getApiErrorMessage(err, 'Could not run the batch'));
          setResults(null);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      selectedPlaintext,
      tab,
      videoList,
      playlistInput,
      channelInput,
      channelMode,
      channelQuery,
      browseLimit,
      format,
      language,
      nativeOnly,
      translateTo,
    ],
  );
```

- [ ] **Step 7: Update the `curlPreview` memo to follow the active tab**

Replace the existing `curlPreview` `useMemo` with:

```tsx
  const curlPreview = useMemo(() => {
    const opts = {
      format,
      language,
      nativeOnly,
      translateTo,
      bearerPlaintext: selectedPlaintext,
    };
    if (tab === 'playlist') {
      return buildCurlPreview({
        mode: 'playlist',
        playlist: playlistInput,
        limit: browseLimit,
        ...opts,
      });
    }
    if (tab === 'channel') {
      return buildCurlPreview({
        mode: 'channel',
        channel: channelInput,
        channelMode,
        channelQuery,
        limit: browseLimit,
        ...opts,
      });
    }
    return buildCurlPreview({
      mode: 'video',
      firstUrl: videoList[0]?.url ?? null,
      ...opts,
    });
  }, [
    tab,
    videoList,
    playlistInput,
    channelInput,
    channelMode,
    channelQuery,
    browseLimit,
    format,
    language,
    nativeOnly,
    translateTo,
    selectedPlaintext,
  ]);
```

- [ ] **Step 8: Verify typecheck and lint**

Run from `frontend/`: `npm run type-check && npm run lint`
Expected: zero errors and zero warnings across the project.

- [ ] **Step 9: Manual verification**

Run `npm run dev`, open `/dashboard/playground`, pick a stashed API key:
- **Playlist tab:** paste a playlist URL, set Limit to 3, submit. Expected: result rows appear and fill in from queued → done as polling runs; the curl preview shows `POST /v1/transcripts/bulk`.
- **Channel tab:** paste a channel handle, try each mode (latest / all videos / search-with-query). Expected: same progressive results.
- **Videos tab:** unchanged — still works per-URL.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/features/playground/PlaygroundClient.tsx
git commit -m "feat(playground): restore playlist and channel tabs (queue-backed)"
```

---

## Task 7: Spec note and end-to-end verification

**Files:**
- Modify: `docs/superpowers/specs/2026-05-16-async-transcript-queue-design.md`

- [ ] **Step 1: Update the async-queue design spec**

In `docs/superpowers/specs/2026-05-16-async-transcript-queue-design.md`, find the Routes section text that states there is no API bulk endpoint (the paragraph beginning "There is no API bulk endpoint — bulk fan-out is a dashboard-only feature"). Replace that paragraph with:

```
A public bulk endpoint was added later — `POST /v1/transcripts/bulk` plus
`GET /v1/transcripts/batches/:id` — see
`docs/superpowers/specs/2026-05-16-public-bulk-transcript-api-design.md`. It is
queue-backed (enqueue + poll), not synchronous.
```

Also add a row to the `/v1` section of the routes table:

```
| `POST /v1/transcripts/bulk` | Expand a playlist/channel/URL-list and enqueue the batch; returns `202` + `{ batch, requests }`. |
| `GET /v1/transcripts/batches/:id` | API mirror to poll a batch. |
```

- [ ] **Step 2: Commit the doc**

```bash
git add docs/superpowers/specs/2026-05-16-async-transcript-queue-design.md
git commit -m "docs: record the public bulk transcript endpoints"
```

- [ ] **Step 3: Full backend + frontend gate**

Run from `backend/`: `npm run typecheck && npm test` — expect clean.
Run from `frontend/`: `npm run type-check && npm run lint && npm run build` — expect a clean build.

- [ ] **Step 4: End-to-end manual verification**

With the backend and frontend running:
1. **Playlist via API:** `POST /v1/transcripts/bulk` with a playlist URL → `202 { batch, requests }`; poll `GET /v1/transcripts/batches/:id` until `progress.queued + progress.processing === 0`.
2. **Channel search:** `POST /v1/transcripts/bulk` with `{ channel, channelMode: "search", channelQuery, limit }` → batch of matching videos.
3. **Over-cap:** a request resolving to > 100 videos → `400`.
4. **Playground:** Playlist and Channel tabs each produce progressively-filling result rows; the Videos tab still works.
5. **Credit gate:** as a user who cannot afford the batch → `402`, nothing enqueued.

- [ ] **Step 5: Final commit (if verification fixes were needed)**

```bash
git add -A
git commit -m "test(queue): public bulk API end-to-end verification fixes"
```

---

## Self-Review Notes

- **Spec coverage:** `POST /v1/transcripts/bulk` (Task 3), `GET /v1/transcripts/batches/:id` (Task 4), channel modes videos/latest/search (Tasks 1, 3, 6), 100-video cap (Task 1 `assertWithinCap`), shared expansion helper / dashboard de-duplication (Tasks 1, 2), playground 3 tabs + limit default 5 (Task 6), queue-backed enqueue-and-poll (Task 6 `runBulk`), curl preview (Task 5), reversed "no API bulk endpoint" decision (Task 7). All spec sections map to a task.
- **Type consistency:** `expandBulkSource` / `BulkExpansionInput` / `BulkExpansionResult` / `ChannelMode` are defined once in Task 1 and consumed in Tasks 2–3. `runBulk` returns `TranscriptRequest[]`; `BatchCreateResponse` / `BatchDetailResponse` are the existing `@/lib/api` types. `BulkResultEntry` is unchanged from the current playground (`ok: true` already carries `requestId`).
- **No test framework added to the frontend** — verification is type-check + lint + build + manual, consistent with the existing frontend plan.
