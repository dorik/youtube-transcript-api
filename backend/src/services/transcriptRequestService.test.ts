import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../db/pool', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
  withTransaction: async (fn: (c: unknown) => unknown) =>
    fn({ query: (...a: unknown[]) => queryMock(...a) }),
}));

const creditMock = vi.hoisted(() => ({ getCreditState: vi.fn() }));
vi.mock('./creditService', () => creditMock);

const queueMock = vi.hoisted(() => ({
  enqueueTranscriptJob: vi.fn().mockResolvedValue('job-1'),
  removeTranscriptJob: vi.fn(),
}));
vi.mock('../queue/transcriptQueue', () => queueMock);

const cacheMock = vi.hoisted(() => ({ getCached: vi.fn() }));
vi.mock('./cacheService', () => cacheMock);

import {
  enqueueSingleRequest,
  cancelRequest,
  enqueueBatch,
} from './transcriptRequestService';
import { PaymentRequiredError, ConflictError } from '../utils/errors';

beforeEach(() => {
  queryMock.mockReset();
  creditMock.getCreditState.mockReset();
  queueMock.enqueueTranscriptJob.mockClear();
  queueMock.removeTranscriptJob.mockClear();
  cacheMock.getCached.mockReset();
});

describe('enqueueSingleRequest', () => {
  it('rejects with PaymentRequiredError when balance minus pending < 1', async () => {
    creditMock.getCreditState.mockResolvedValue({ balance: 1 });
    // findDuplicate -> none; countPending -> 1
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // findDuplicateRequest
      .mockResolvedValueOnce({ rows: [{ n: 1 }] }); // countPendingRequests

    await expect(
      enqueueSingleRequest({
        userId: 'u1',
        source: 'dashboard',
        config: { url: 'https://youtu.be/dQw4w9WgXcQ', format: 'json' },
      }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(queueMock.enqueueTranscriptJob).not.toHaveBeenCalled();
  });

  it('returns the existing row when a duplicate is found', async () => {
    const existing = { id: 'r-existing', status: 'queued' };
    queryMock.mockResolvedValueOnce({ rows: [existing] }); // findDuplicateRequest

    const result = await enqueueSingleRequest({
      userId: 'u1',
      source: 'dashboard',
      config: { url: 'https://youtu.be/dQw4w9WgXcQ', format: 'json' },
    });

    expect(result.id).toBe('r-existing');
    expect(queueMock.enqueueTranscriptJob).not.toHaveBeenCalled();
  });
});

describe('cancelRequest', () => {
  it('cancels a queued request', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'r1', user_id: 'u1', status: 'queued', bullmq_job_id: 'job-1' }],
      }) // getUserRequest SELECT
      .mockResolvedValueOnce({
        rows: [{ id: 'r1', status: 'canceled' }],
      }); // conditional UPDATE

    const result = await cancelRequest('r1', 'u1');

    expect(result?.status).toBe('canceled');
    expect(queueMock.removeTranscriptJob).toHaveBeenCalledWith('job-1');
  });

  it('throws ConflictError when the worker already grabbed the row', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'r1', user_id: 'u1', status: 'queued', bullmq_job_id: 'job-1' }],
      }) // getUserRequest SELECT
      .mockResolvedValueOnce({ rows: [] }); // conditional UPDATE — 0 rows matched

    await expect(cancelRequest('r1', 'u1')).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// enqueueBatch — cache pre-check language normalization
// ---------------------------------------------------------------------------

describe('enqueueBatch cache pre-check', () => {
  const VIDEO = {
    url: 'https://youtu.be/dQw4w9WgXcQ',
    video_id: 'dQw4w9WgXcQ',
    title: 'Test Video',
  };
  const BATCH_ROW = {
    id: 'batch-1',
    user_id: 'u1',
    kind: 'videos',
    source_url: null,
    label: null,
    total: 1,
    created_at: new Date(),
  };
  const REQUEST_ROW = {
    id: 'req-1',
    user_id: 'u1',
    source: 'dashboard',
    status: 'completed',
    request: { url: VIDEO.url, format: 'json', language: 'english' },
    video_id: VIDEO.video_id,
    title: VIDEO.title,
    channel: null,
    duration_seconds: null,
    thumbnail_url: null,
    bullmq_job_id: null,
    attempts: 0,
    result: null,
    credits_used: 0,
    error_code: null,
    error_message: null,
    batch_id: 'batch-1',
    batch_position: 0,
    created_at: new Date(),
    started_at: null,
    completed_at: new Date(),
  };

  it('treats a non-canonical language string as a cache hit when the normalized key is cached', async () => {
    // getCached is called with the normalized key ('en'), which is cached.
    cacheMock.getCached.mockResolvedValue({ videoId: VIDEO.video_id, language: 'en' });
    creditMock.getCreditState.mockResolvedValue({ balance: 5 });
    // countPendingRequests
    queryMock
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // countPendingRequests
      .mockResolvedValueOnce({ rows: [BATCH_ROW] }) // INSERT transcript_batches
      .mockResolvedValueOnce({ rows: [REQUEST_ROW] }) // INSERT transcript_requests
      .mockResolvedValueOnce({ rows: [] }); // logApiRequest INSERT api_requests

    const result = await enqueueBatch({
      userId: 'u1',
      kind: 'videos',
      sourceUrl: null,
      label: null,
      videos: [VIDEO],
      config: { format: 'json', language: 'english' },
    });

    // The video must be inserted as 'completed' (cache hit, 0 credits).
    expect(result.requests[0].status).toBe('completed');
    // getCached must have been called with the normalized code, not 'english'.
    expect(cacheMock.getCached).toHaveBeenCalledWith(VIDEO.video_id, 'en');
    // No BullMQ job should be enqueued for a cache-hit row.
    expect(queueMock.enqueueTranscriptJob).not.toHaveBeenCalled();
  });

  it('queues and charges for a video when the non-canonical language does not normalize to a cached key', async () => {
    // getCached returns null → cache miss → video must be queued.
    cacheMock.getCached.mockResolvedValue(null);
    creditMock.getCreditState.mockResolvedValue({ balance: 5 });
    queryMock
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // countPendingRequests
      .mockResolvedValueOnce({ rows: [BATCH_ROW] }) // INSERT transcript_batches
      .mockResolvedValueOnce({ rows: [{ ...REQUEST_ROW, status: 'queued', completed_at: null }] }) // INSERT transcript_requests
      .mockResolvedValueOnce({ rows: [] }); // UPDATE bullmq_job_id

    const result = await enqueueBatch({
      userId: 'u1',
      kind: 'videos',
      sourceUrl: null,
      label: null,
      videos: [VIDEO],
      config: { format: 'json', language: 'english' },
    });

    expect(result.requests[0].status).toBe('queued');
    expect(queueMock.enqueueTranscriptJob).toHaveBeenCalledOnce();
  });
});
