CREATE TABLE IF NOT EXISTS cached_transcripts (
  video_id VARCHAR(20) NOT NULL,
  language VARCHAR(20) NOT NULL DEFAULT 'en',
  url VARCHAR(500),
  title VARCHAR(512),
  channel VARCHAR(255),
  duration_seconds INTEGER,
  upload_date DATE,
  source VARCHAR(50),
  transcript_text TEXT NOT NULL,
  segments JSONB NOT NULL,
  character_count INTEGER,
  segment_count INTEGER,
  first_cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  PRIMARY KEY (video_id, language)
);

CREATE INDEX IF NOT EXISTS idx_cached_transcripts_video_id ON cached_transcripts(video_id);
CREATE INDEX IF NOT EXISTS idx_cached_transcripts_expires_at ON cached_transcripts(expires_at);
CREATE INDEX IF NOT EXISTS idx_cached_transcripts_access_count ON cached_transcripts(access_count);
