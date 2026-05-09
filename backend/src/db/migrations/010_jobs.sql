CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 'videos' = explicit list of URLs/IDs;
  -- 'playlist' = expanded from a YouTube playlist (Phase-2 work);
  -- 'channel'  = expanded from a YouTube channel  (Phase-2 work).
  input_type VARCHAR(20) NOT NULL,

  -- Snapshot of the request configuration so the user can later see what was
  -- requested even after defaults change.
  config JSONB NOT NULL,

  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|processing|completed|failed
  total_videos INTEGER NOT NULL DEFAULT 0,
  completed_videos INTEGER NOT NULL DEFAULT 0,
  failed_videos INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS job_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  input_url VARCHAR(500) NOT NULL,
  video_id VARCHAR(20),

  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
  source VARCHAR(50),                              -- native_captions|whisper
  language VARCHAR(20),
  title VARCHAR(512),
  channel VARCHAR(255),
  duration_seconds INTEGER,
  segment_count INTEGER,
  word_count INTEGER,
  credits_used INTEGER,
  cached BOOLEAN,

  error_code VARCHAR(50),
  error_message TEXT,

  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_job_videos_job_id ON job_videos(job_id);
CREATE INDEX IF NOT EXISTS idx_job_videos_status ON job_videos(status);
CREATE INDEX IF NOT EXISTS idx_job_videos_video_id ON job_videos(video_id);
