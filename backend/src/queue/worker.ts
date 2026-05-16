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
import { classifyError } from '../services/errorClassification';
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
    await svc.markCompleted(requestId, result);
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
      throw new UnrecoverableError(message);
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

  // Fires only when a job has truly failed (retries exhausted, or thrown as
  // UnrecoverableError). This is the single place the DB row goes `failed`.
  worker.on('failed', async (job, err) => {
    if (!job || job.name !== JOB_TRANSCRIBE) {
      logger.error({ err, job: job?.name }, 'Queue job failed');
      return;
    }
    const requestId = job.data.requestId;
    try {
      const req = await svc.getRequestById(requestId);
      if (!req || req.status === 'canceled' || req.status === 'completed') {
        return;
      }
      const code =
        err instanceof ApiError
          ? err.code
          : err instanceof UnrecoverableError
            ? 'PERMANENT_FAILURE'
            : 'INTERNAL_ERROR';
      const message = err?.message ?? 'Unknown error';
      await svc.markFailed(requestId, code, message);
      await svc.logApiRequest({
        userId: req.user_id,
        endpoint: req.source === 'api' ? '/v1/transcript' : '/me/transcripts',
        statusCode: err instanceof ApiError ? err.status : 500,
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
