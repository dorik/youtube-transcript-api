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
  cancelBatch,
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
// cancelBatch
// ---------------------------------------------------------------------------

describe('cancelBatch', () => {
  const BATCH_ROW = {
    id: 'batch-1',
    user_id: 'u1',
    kind: 'videos',
    source_url: null,
    label: null,
    total: 3,
    created_at: new Date(),
  };

  it('cancels only queued children and removes their BullMQ jobs', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [BATCH_ROW] }) // getBatch SELECT
      .mockResolvedValueOnce({
        // conditional UPDATE ... WHERE status = 'queued' RETURNING
        rows: [
          { id: 'r1', bullmq_job_id: 'job-1' },
          { id: 'r2', bullmq_job_id: 'job-2' },
        ],
      });

    const result = await cancelBatch('batch-1', 'u1');

    expect(result?.canceledCount).toBe(2);
    expect(result?.batch.id).toBe('batch-1');
    // The UPDATE is scoped to queued rows of this batch only.
    const updateCall = queryMock.mock.calls[1];
    expect(updateCall[0]).toContain("status = 'canceled'");
    expect(updateCall[0]).toContain("WHERE batch_id = $1 AND status = 'queued'");
    expect(updateCall[1]).toEqual(['batch-1']);
    // A job is removed for each canceled (queued) child — not for
    // processing/completed children, which the UPDATE never returns.
    expect(queueMock.removeTranscriptJob).toHaveBeenCalledTimes(2);
    expect(queueMock.removeTranscriptJob).toHaveBeenCalledWith('job-1');
    expect(queueMock.removeTranscriptJob).toHaveBeenCalledWith('job-2');
  });

  it('skips job removal for a canceled child with no bullmq_job_id', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [BATCH_ROW] }) // getBatch SELECT
      .mockResolvedValueOnce({
        rows: [{ id: 'r1', bullmq_job_id: null }],
      }); // conditional UPDATE

    const result = await cancelBatch('batch-1', 'u1');

    expect(result?.canceledCount).toBe(1);
    expect(queueMock.removeTranscriptJob).not.toHaveBeenCalled();
  });

  it('reports zero canceled when no children are still queued', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [BATCH_ROW] }) // getBatch SELECT
      .mockResolvedValueOnce({ rows: [] }); // UPDATE matched nothing

    const result = await cancelBatch('batch-1', 'u1');

    expect(result?.canceledCount).toBe(0);
    expect(queueMock.removeTranscriptJob).not.toHaveBeenCalled();
  });

  it('returns null for a missing batch or one owned by another user', async () => {
    // getBatch is user-scoped (WHERE id = $1 AND user_id = $2) → no rows.
    queryMock.mockResolvedValueOnce({ rows: [] }); // getBatch SELECT

    const result = await cancelBatch('batch-1', 'other-user');

    expect(result).toBeNull();
    // No UPDATE and no job removal when ownership check fails.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queueMock.removeTranscriptJob).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// enqueueBatch — cache hits are queued (never short-cut to `completed`), and
// the cache pre-check only sizes the credit gate (bug C1).
// ---------------------------------------------------------------------------

describe('enqueueBatch', () => {
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
  const QUEUED_ROW = {
    id: 'req-1',
    user_id: 'u1',
    source: 'api',
    status: 'queued',
    request: { url: VIDEO.url, format: 'json', language: 'english' },
    video_id: VIDEO.video_id,
    title: VIDEO.title,
    channel: null,
    duration_seconds: null,
    thumbnail_url: null,
    bullmq_job_id: null,
    attempts: 0,
    result: null,
    credits_used: null,
    error_code: null,
    error_message: null,
    batch_id: 'batch-1',
    batch_position: 0,
    created_at: new Date(),
    started_at: null,
    completed_at: null,
  };

  const baseInput = {
    userId: 'u1',
    source: 'api' as const,
    kind: 'videos' as const,
    sourceUrl: null,
    label: null,
    videos: [VIDEO],
    config: { format: 'json' as const, language: 'english' },
  };

  it('inserts a cache-hit video as `queued` and enqueues a worker job (C1)', async () => {
    // getCached is called with the normalized key ('en'), which is cached.
    cacheMock.getCached.mockResolvedValue({ videoId: VIDEO.video_id, language: 'en' });
    creditMock.getCreditState.mockResolvedValue({ balance: 5 });
    queryMock
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // countPendingRequests
      .mockResolvedValueOnce({ rows: [BATCH_ROW] }) // INSERT transcript_batches
      .mockResolvedValueOnce({ rows: [QUEUED_ROW] }) // INSERT transcript_requests
      .mockResolvedValueOnce({ rows: [] }); // UPDATE bullmq_job_id

    const result = await enqueueBatch(baseInput);

    // C1: a cache hit must NOT be born `completed` with no result. It is
    // queued so the worker resolves it (full result, 0 credits) like any row.
    expect(result.requests[0].status).toBe('queued');
    expect(queueMock.enqueueTranscriptJob).toHaveBeenCalledOnce();
    // getCached must have been called with the normalized code, not 'english'.
    expect(cacheMock.getCached).toHaveBeenCalledWith(VIDEO.video_id, 'en');
  });

  it('does not charge for a cache hit: a 0-balance user can still batch a cached video', async () => {
    cacheMock.getCached.mockResolvedValue({ videoId: VIDEO.video_id, language: 'en' });
    creditMock.getCreditState.mockResolvedValue({ balance: 0 });
    queryMock
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // countPendingRequests
      .mockResolvedValueOnce({ rows: [BATCH_ROW] }) // INSERT transcript_batches
      .mockResolvedValueOnce({ rows: [QUEUED_ROW] }) // INSERT transcript_requests
      .mockResolvedValueOnce({ rows: [] }); // UPDATE bullmq_job_id

    const result = await enqueueBatch(baseInput);

    expect(result.requests[0].status).toBe('queued');
    expect(queueMock.enqueueTranscriptJob).toHaveBeenCalledOnce();
  });

  it('rejects a cache-miss batch the user cannot afford', async () => {
    cacheMock.getCached.mockResolvedValue(null); // cache miss → 1 uncached video
    creditMock.getCreditState.mockResolvedValue({ balance: 0 });
    queryMock.mockResolvedValueOnce({ rows: [{ n: 0 }] }); // countPendingRequests

    await expect(enqueueBatch(baseInput)).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(queueMock.enqueueTranscriptJob).not.toHaveBeenCalled();
  });

  it('records the request `source` on every batch row (M3)', async () => {
    cacheMock.getCached.mockResolvedValue(null);
    creditMock.getCreditState.mockResolvedValue({ balance: 5 });
    queryMock
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // countPendingRequests
      .mockResolvedValueOnce({ rows: [BATCH_ROW] }) // INSERT transcript_batches
      .mockResolvedValueOnce({ rows: [QUEUED_ROW] }) // INSERT transcript_requests
      .mockResolvedValueOnce({ rows: [] }); // UPDATE bullmq_job_id

    await enqueueBatch({ ...baseInput, source: 'api' });

    // The per-video INSERT must bind `source` from the input ($2), not a
    // hardcoded 'dashboard' literal.
    const insertCall = queryMock.mock.calls[2];
    expect(insertCall[0]).toContain('INSERT INTO transcript_requests');
    expect(insertCall[1][1]).toBe('api');
  });
});
