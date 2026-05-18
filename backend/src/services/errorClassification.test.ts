import { describe, it, expect } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { classifyError, resolveFailureCode } from './errorClassification';
import {
  NoTranscriptError,
  UpgradeRequiredError,
  UpstreamBlockedError,
  ValidationError,
  PaymentRequiredError,
  VideoNotFoundError,
} from '../utils/errors';

describe('classifyError', () => {
  it('treats UpstreamBlockedError as transient', () => {
    expect(classifyError(new UpstreamBlockedError(60))).toBe('transient');
  });

  it('treats a generic network error as transient', () => {
    expect(classifyError(new Error('socket hang up'))).toBe('transient');
  });

  it('treats NoTranscriptError as permanent', () => {
    expect(classifyError(new NoTranscriptError('vid123'))).toBe('permanent');
  });

  it('treats UpgradeRequiredError as permanent', () => {
    expect(classifyError(new UpgradeRequiredError('AI transcription'))).toBe('permanent');
  });

  it('treats ValidationError as permanent', () => {
    expect(classifyError(new ValidationError('bad url'))).toBe('permanent');
  });

  it('treats PaymentRequiredError as permanent', () => {
    expect(classifyError(new PaymentRequiredError(1, 0))).toBe('permanent');
  });

  it('treats VideoNotFoundError as permanent', () => {
    expect(classifyError(new VideoNotFoundError('vid123'))).toBe('permanent');
  });
});

describe('resolveFailureCode', () => {
  it('takes the code and status straight off an ApiError', () => {
    expect(resolveFailureCode(new VideoNotFoundError('vid123'))).toEqual({
      code: 'VIDEO_NOT_FOUND',
      status: 404,
    });
  });

  it('reads the code/status the worker copies onto an UnrecoverableError', () => {
    // The worker re-throws permanent failures as UnrecoverableError to stop
    // BullMQ retries, copying the original ApiError code/status onto it so
    // the precise failure survives the retry boundary.
    const wrapped = new UnrecoverableError('No native captions');
    Object.assign(wrapped, { code: 'NO_TRANSCRIPT', status: 404 });
    expect(resolveFailureCode(wrapped)).toEqual({
      code: 'NO_TRANSCRIPT',
      status: 404,
    });
  });

  it('falls back to PERMANENT_FAILURE for a bare UnrecoverableError', () => {
    expect(resolveFailureCode(new UnrecoverableError('boom'))).toEqual({
      code: 'PERMANENT_FAILURE',
      status: 500,
    });
  });

  it('falls back to INTERNAL_ERROR for an unknown error', () => {
    expect(resolveFailureCode(new Error('socket hang up'))).toEqual({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  });
});
