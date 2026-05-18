import { Worker, UnrecoverableError, Job } from 'bullmq';
import { queueConnection } from './connection';
import {
  TRANSCRIPT_QUEUE_NAME,
  JOB_TRANSCRIBE,
  JOB_CLEANUP,
  TranscriptJobData,
  transcriptQueue,
} from './transcriptQueue';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { getTranscript } from '../services/transcriptService';
import { fetchYouTubeMetadata } from '../services/youtubeService';
import { classifyError, resolveFailureCode } from '../services/errorClassification';
import { ApiError } from '../utils/errors';
import * as svc from '../services/transcriptRequestService';

async function processTranscribe(job: Job<TranscriptJobData>): Promise<void> {
  const { requestId } = job.data;
  const req = await svc.getRequestById(requestId);
  if (!req) {
    logger.warn({ requestId }, 'Transcript request row missing; dropping job');
    return;
  }
  if (req.status === 'canceled') {
    logger.info({ requestId }, 'Request canceled before processing; skipping');
    return;
  }

  const attempt = job.attemptsMade + 1;
  await svc.markProcessing(requestId, attempt);

  // Step 1: cheap metadata so the row renders before transcription finishes.
  // fetchYouTubeMetadata returns title, channel, thumbnailUrl but not
  // durationSeconds — that comes later from the transcript result itself.
  if (req.video_id && !req.title) {
    try {
      const meta = await fetchYouTubeMetadata(req.video_id);
      await svc.setMetadata(requestId, {
        title: meta.title,
        channel: meta.channel,
        durationSeconds: null,
        // Use the predictable mqdefault URL directly rather than meta.thumbnailUrl,
        // which can vary in quality/format. meta is still used for title and channel.
        thumbnailUrl: `https://img.youtube.com/vi/${req.video_id}/mqdefault.jpg`,
      });
    } catch (err) {
      logger.info({ err, requestId }, 'Metadata prefetch failed; continuing');
    }
  }

  // Step 2: the real transcript work — unchanged orchestration.
  try {
    const result = await getTranscript({
      userId: req.user_id,
      url: req.request.url,
      format: req.request.format,
      language: req.request.language,
      nativeOnly: req.request.native_only,
      translateTo: req.request.translate_to,
    });

    // Post-success persistence: markCompleted + logApiRequest must be
    // retried independently from the BullMQ retry loop.
    //
    // WHY: getTranscript() already deducted the credit (via deductCredits
    // inside transcriptService). If markCompleted throws a transient DB
    // error and we let the exception bubble, BullMQ will either retry the
    // whole job (where getTranscript will cache-hit and charge 0 — still
    // OK) OR, on the final exhausted attempt, the `failed` event handler
    // will mark the row `failed`. That last outcome violates the spec
    // invariant "failed requests cost nothing" because the credit was
    // already charged on an earlier attempt. A small bounded retry here
    // makes persistence resilient to transient DB blips without needing a
    // refund flow (which the spec explicitly excludes).
    const PERSIST_RETRIES = 3;
    const PERSIST_DELAY_MS = 500;
    for (let i = 0; i < PERSIST_RETRIES; i++) {
      try {
        await svc.markCompleted(requestId, result);
        break; // success — stop retrying
      } catch (persistErr) {
        if (i < PERSIST_RETRIES - 1) {
          logger.warn(
            { persistErr, requestId, persistAttempt: i + 1 },
            'markCompleted failed after credit was charged; retrying persistence',
          );
          await new Promise((resolve) => setTimeout(resolve, PERSIST_DELAY_MS));
        } else {
          // All persistence retries exhausted. Re-throw so BullMQ retries
          // the whole job (getTranscript will cache-hit at 0 cost) rather
          // than silently leaving the row in `processing` forever.
          logger.error(
            { persistErr, requestId },
            'markCompleted failed on all retries after credit was charged; letting BullMQ retry the job',
          );
          throw persistErr;
        }
      }
    }

    await svc.logApiRequest({
      userId: req.user_id,
      endpoint: req.source === 'api' ? '/v1/transcript' : '/me/transcripts',
      statusCode: 200,
      videoId: result.video_id,
      format: req.request.format,
      language: req.request.language ?? null,
      transcriptSource: result.source,
      cacheHit: result.cached,
      creditsUsed: result.credits_used,
      errorCode: null,
    });
  } catch (err) {
    // Permanent failures must not be retried; transient ones are re-thrown
    // so BullMQ retries. The DB row is marked `failed` by the worker's
    // `failed` event handler — which fires only on the final, exhausted
    // attempt — so retries in between leave the row as `processing`.
    if (classifyError(err) === 'permanent') {
      const message = err instanceof Error ? err.message : 'Unknown error';
      // Re-throw as UnrecoverableError so BullMQ stops retrying, but copy the
      // original ApiError code/status onto it first. The worker's in-process
      // `failed` listener receives this exact instance, so `resolveFailureCode`
      // can record the precise failure (VIDEO_NOT_FOUND, NO_TRANSCRIPT, …)
      // instead of a generic PERMANENT_FAILURE.
      const unrecoverable = new UnrecoverableError(message);
      if (err instanceof ApiError) {
        Object.assign(unrecoverable, { code: err.code, status: err.status });
      }
      throw unrecoverable;
    }
    logger.warn(
      { err, requestId, attempt },
      'Transient transcript failure; BullMQ will retry if attempts remain',
    );
    throw err;
  }
}

async function processCleanup(): Promise<void> {
  const purged = await svc.purgeOldRequests(30);
  logger.info({ purged }, 'Transcript retention sweep complete');
}

let worker: Worker<TranscriptJobData> | null = null;

/**
 * Start the in-process BullMQ worker and register the daily retention job.
 * Idempotent — calling twice is a no-op.
 */
export async function startWorker(): Promise<void> {
  if (worker) return;

  worker = new Worker<TranscriptJobData>(
    TRANSCRIPT_QUEUE_NAME,
    async (job) => {
      if (job.name === JOB_CLEANUP) return processCleanup();
      return processTranscribe(job);
    },
    { connection: queueConnection, concurrency: config.QUEUE_CONCURRENCY },
  );

  // BullMQ 5.x emits `failed` on EVERY failed attempt, not only the final one.
  // The guard below narrows it to the final outcome (no further retry will run).
  worker.on('failed', async (job, err) => {
    if (!job || job.name !== JOB_TRANSCRIBE) {
      logger.error({ err, job: job?.name }, 'Queue job failed');
      return;
    }
    // BullMQ increments job.attemptsMade before emitting `failed`, so after
    // attempt N it equals N. A job will be retried when attemptsMade is still
    // below opts.attempts AND the error is not UnrecoverableError (which skips
    // remaining attempts immediately). Return early on intermediate attempts so
    // we write to the DB only once — on the truly-final failure.
    const isUnrecoverable =
      err instanceof UnrecoverableError || err?.name === 'UnrecoverableError';
    if (!isUnrecoverable && job.attemptsMade < (job.opts.attempts ?? 1)) {
      return;
    }
    const requestId = job.data.requestId;
    try {
      const req = await svc.getRequestById(requestId);
      if (!req || req.status === 'canceled' || req.status === 'completed') {
        return;
      }
      const { code, status } = resolveFailureCode(err);
      const message = err?.message ?? 'Unknown error';
      await svc.markFailed(requestId, code, message);
      await svc.logApiRequest({
        userId: req.user_id,
        endpoint: req.source === 'api' ? '/v1/transcript' : '/me/transcripts',
        statusCode: status,
        videoId: req.video_id,
        format: req.request.format,
        language: req.request.language ?? null,
        transcriptSource: null,
        cacheHit: null,
        creditsUsed: 0,
        errorCode: code,
      });
    } catch (handlerErr) {
      logger.error({ handlerErr, requestId }, 'Failed to record job failure');
    }
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'BullMQ worker error');
  });

  // BullMQ silently loses jobs if Redis evicts keys. Render's free Key Value
  // datastore can default to an eviction policy other than noeviction — warn
  // loudly so the operator fixes it in the Render dashboard.
  try {
    const policy = await queueConnection.config('GET', 'maxmemory-policy');
    const value = Array.isArray(policy) ? policy[1] : undefined;
    if (value && value !== 'noeviction') {
      logger.warn(
        { maxmemoryPolicy: value },
        'Redis maxmemory-policy is not "noeviction" — queued jobs may be evicted. Set it to noeviction.',
      );
    }
  } catch (err) {
    logger.info({ err }, 'Could not read Redis maxmemory-policy (non-fatal)');
  }

  // Daily retention sweep. `jobId` keeps the repeatable job unique across
  // restarts so we don't accumulate duplicate schedules.
  await transcriptQueue.add(
    JOB_CLEANUP,
    {},
    { repeat: { pattern: '0 3 * * *' }, jobId: 'retention-sweep' },
  );

  logger.info(
    { concurrency: config.QUEUE_CONCURRENCY },
    'Transcript worker started',
  );
}

export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
