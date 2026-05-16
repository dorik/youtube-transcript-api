import { Queue } from 'bullmq';
import { EventEmitter } from 'node:events';
import { logger } from '../config/logger';
import { queueConnection } from './connection';

export const TRANSCRIPT_QUEUE_NAME = 'transcript-requests';

/** Job name for a single transcript request. */
export const JOB_TRANSCRIBE = 'transcribe';
/** Job name for the daily retention sweep. */
export const JOB_CLEANUP = 'cleanup';

export interface TranscriptJobData {
  requestId: string;
}

export const transcriptQueue = new Queue(TRANSCRIPT_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/**
 * In-process status bus. The worker emits an `update` event after every DB
 * status write; the SSE route subscribes. In-process is sufficient because the
 * worker runs inside the web service. If the worker is ever split into its own
 * process, replace this with BullMQ QueueEvents / Redis pub-sub.
 */
export interface TranscriptUpdateEvent {
  userId: string;
  requestId: string;
  batchId: string | null;
  status: string;
}

export const transcriptEvents = new EventEmitter();
// One listener per open SSE connection; lift the default 10-listener cap.
transcriptEvents.setMaxListeners(0);

export function emitTranscriptUpdate(e: TranscriptUpdateEvent): void {
  transcriptEvents.emit('update', e);
}

/** Enqueue one transcript request; returns the BullMQ job id. */
export async function enqueueTranscriptJob(requestId: string): Promise<string> {
  const job = await transcriptQueue.add(JOB_TRANSCRIBE, { requestId });
  return job.id!;
}

/** Remove a not-yet-active job (used to cancel a queued request). */
export async function removeTranscriptJob(jobId: string): Promise<void> {
  const job = await transcriptQueue.getJob(jobId);
  if (!job) return;
  try {
    await job.remove();
  } catch (err) {
    // Best-effort: a job the worker has already picked up cannot be
    // removed. The worker re-checks the DB row's `canceled` status before
    // doing work, so a failed removal is not a correctness problem — but
    // log it so a real Redis error is not invisible.
    logger.warn({ err, jobId }, 'Could not remove queued transcript job');
  }
}
