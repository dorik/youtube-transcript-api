-- Async transcript queue.
--
-- transcript_requests : one row per transcript request (single or batch child).
-- transcript_batches  : groups the rows of a bulk playlist/channel submission.
--
-- This supersedes the never-used jobs / job_videos tables (migration 010),
-- which are dropped here. The migration runner wraps each file in one
-- transaction, so the DROP + CREATE statements below are atomic together.

DROP TABLE IF EXISTS job_videos;
DROP TABLE IF EXISTS jobs;

CREATE TABLE IF NOT EXISTS transcript_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        VARCHAR(10) NOT NULL CHECK (kind IN ('playlist', 'channel', 'videos')),
  source_url  VARCHAR(500),
  label       VARCHAR(512),
  total       INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transcript_batches_user
  ON transcript_batches(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transcript_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source           VARCHAR(10) NOT NULL CHECK (source IN ('api', 'dashboard')),
  status           VARCHAR(12) NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'processing', 'completed',
                                        'failed', 'canceled')),
  request          JSONB NOT NULL,            -- { url, format, language,
                                               --   native_only, translate_to }
  video_id         VARCHAR(20),
  title            VARCHAR(512),
  channel          VARCHAR(255),
  duration_seconds INTEGER,
  thumbnail_url    VARCHAR(500),
  bullmq_job_id    VARCHAR(64),
  attempts         INTEGER NOT NULL DEFAULT 0,
  result           JSONB,                      -- full TranscriptResponse; set on completion
  credits_used     INTEGER,
  error_code       VARCHAR(50),
  error_message    TEXT,
  batch_id         UUID REFERENCES transcript_batches(id) ON DELETE CASCADE,
  batch_position   INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transcript_requests_user
  ON transcript_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_requests_status
  ON transcript_requests(status);
CREATE INDEX IF NOT EXISTS idx_transcript_requests_batch
  ON transcript_requests(batch_id);
