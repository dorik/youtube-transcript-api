/**
 * Public-facing API error. The error handler middleware turns this into a
 * JSON envelope: `{ error, code, message, ...details }`.
 *
 * Always throw a subclass of `ApiError` for things the client should see;
 * unknown errors get logged and returned as a generic 500.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly errorType: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }

  toJSON() {
    return {
      error: this.errorType,
      code: this.code,
      message: this.message,
      ...(this.details ?? {}),
    };
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, 'VALIDATION_ERROR', 'invalid_request', message, details);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(401, code, 'unauthorized', message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', 'forbidden', message);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Not found', code = 'NOT_FOUND') {
    super(404, code, 'not_found', message);
  }
}

export class ConflictError extends ApiError {
  constructor(message: string, code = 'CONFLICT') {
    super(409, code, 'conflict', message);
  }
}

export class PaymentRequiredError extends ApiError {
  constructor(creditsRequired: number, creditsAvailable: number) {
    super(
      402,
      'INSUFFICIENT_CREDITS',
      'insufficient_credits',
      `This request requires ${creditsRequired} credits; you have ${creditsAvailable}.`,
      { credits_required: creditsRequired, credits_available: creditsAvailable },
    );
  }
}

export class RateLimitError extends ApiError {
  constructor(retryAfterSeconds: number) {
    super(
      429,
      'RATE_LIMIT_EXCEEDED',
      'rate_limited',
      'You have exceeded your rate limit. Slow down and try again.',
      { retry_after: retryAfterSeconds },
    );
  }
}

export class NoTranscriptError extends ApiError {
  constructor(videoId: string) {
    super(
      404,
      'NO_TRANSCRIPT',
      'no_transcript',
      `No native captions available for video ${videoId}.`,
    );
  }
}

export class VideoNotFoundError extends ApiError {
  constructor(videoId: string) {
    super(
      404,
      'VIDEO_NOT_FOUND',
      'video_not_found',
      `The video ${videoId} could not be found or is no longer available.`,
    );
  }
}
