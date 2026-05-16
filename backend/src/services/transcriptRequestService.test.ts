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

import { enqueueSingleRequest, cancelRequest } from './transcriptRequestService';
import { PaymentRequiredError, ConflictError } from '../utils/errors';

beforeEach(() => {
  queryMock.mockReset();
  creditMock.getCreditState.mockReset();
  queueMock.enqueueTranscriptJob.mockClear();
  queueMock.removeTranscriptJob.mockClear();
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
