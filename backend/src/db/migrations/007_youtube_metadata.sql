CREATE TABLE IF NOT EXISTS youtube_metadata_cache (
  video_id VARCHAR(20) PRIMARY KEY,
  title VARCHAR(512),
  channel VARCHAR(255),
  channel_id VARCHAR(255),
  upload_date DATE,
  duration_seconds INTEGER,
  view_count BIGINT,
  like_count INTEGER,
  thumbnail_url VARCHAR(512),
  is_age_restricted BOOLEAN NOT NULL DEFAULT FALSE,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
);

CREATE INDEX IF NOT EXISTS idx_yt_metadata_expires_at ON youtube_metadata_cache(expires_at);
