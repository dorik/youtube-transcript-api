import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  NoTranscriptError,
  NotFoundError,
  PaymentRequiredError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
  VideoNotFoundError,
} from './errors';

describe('ApiError base class', () => {
  it('carries status, code, errorType, message, details', () => {
    const err = new ApiError(418, 'I_AM_A_TEAPOT', 'teapot', 'short and stout', { side: 'handle' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(418);
    expect(err.code).toBe('I_AM_A_TEAPOT');
    expect(err.errorType).toBe('teapot');
    expect(err.message).toBe('short and stout');
    expect(err.details).toEqual({ side: 'handle' });
  });

  it('toJSON merges details with the public envelope', () => {
    const err = new ApiError(400, 'BAD', 'bad_request', 'nope', { field: 'email' });
    expect(err.toJSON()).toEqual({
      error: 'bad_request',
      code: 'BAD',
      message: 'nope',
      field: 'email',
    });
  });

  it('toJSON works without details', () => {
    const err = new ApiError(500, 'OOPS', 'server_error', 'boom');
    expect(err.toJSON()).toEqual({ error: 'server_error', code: 'OOPS', message: 'boom' });
  });

  it('the name property reflects the subclass', () => {
    expect(new ValidationError('x').name).toBe('ValidationError');
    expect(new NotFoundError().name).toBe('NotFoundError');
  });
});

describe('ValidationError', () => {
  it('is 400 with VALIDATION_ERROR / invalid_request', () => {
    const err = new ValidationError('bad input', { field: 'url' });
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.errorType).toBe('invalid_request');
    expect(err.toJSON()).toMatchObject({ error: 'invalid_request', field: 'url' });
  });
});

describe('UnauthorizedError', () => {
  it('defaults to 401 / UNAUTHORIZED', () => {
    const err = new UnauthorizedError();
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.errorType).toBe('unauthorized');
    expect(err.message).toBe('Authentication required');
  });

  it('allows overriding the code', () => {
    const err = new UnauthorizedError('bad key', 'INVALID_API_KEY');
    expect(err.code).toBe('INVALID_API_KEY');
    expect(err.message).toBe('bad key');
  });
});

describe('ForbiddenError', () => {
  it('is 403 / FORBIDDEN', () => {
    const err = new ForbiddenError();
    expect(err.status).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.errorType).toBe('forbidden');
  });
});

describe('NotFoundError', () => {
  it('is 404 / NOT_FOUND', () => {
    const err = new NotFoundError();
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('ConflictError', () => {
  it('is 409 / CONFLICT', () => {
    const err = new ConflictError('email already in use');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT');
  });
});

describe('PaymentRequiredError', () => {
  it('is 402 with credits info in details', () => {
    const err = new PaymentRequiredError(10, 3);
    expect(err.status).toBe(402);
    expect(err.code).toBe('INSUFFICIENT_CREDITS');
    expect(err.errorType).toBe('insufficient_credits');
    expect(err.message).toContain('10');
    expect(err.message).toContain('3');
    expect(err.details).toEqual({ credits_required: 10, credits_available: 3 });
    expect(err.toJSON()).toMatchObject({ credits_required: 10, credits_available: 3 });
  });
});

describe('RateLimitError', () => {
  it('is 429 with retry_after in details', () => {
    const err = new RateLimitError(42);
    expect(err.status).toBe(429);
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(err.details).toEqual({ retry_after: 42 });
    expect(err.toJSON()).toMatchObject({ retry_after: 42 });
  });
});

describe('NoTranscriptError', () => {
  it('is 404 / NO_TRANSCRIPT and names the video', () => {
    const err = new NoTranscriptError('abc123');
    expect(err.status).toBe(404);
    expect(err.code).toBe('NO_TRANSCRIPT');
    expect(err.message).toContain('abc123');
  });
});

describe('VideoNotFoundError', () => {
  it('is 404 / VIDEO_NOT_FOUND and names the video', () => {
    const err = new VideoNotFoundError('xyz999');
    expect(err.status).toBe(404);
    expect(err.code).toBe('VIDEO_NOT_FOUND');
    expect(err.message).toContain('xyz999');
  });
});
