import { describe, it, expect } from 'vitest';
import { classifyError } from './errorClassification';
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
