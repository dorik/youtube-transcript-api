CREATE TABLE IF NOT EXISTS api_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  method VARCHAR(10) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  status_code INTEGER NOT NULL,
  video_url VARCHAR(500),
  video_id VARCHAR(20),
  format VARCHAR(50),
  language VARCHAR(20),
  response_time_ms INTEGER,
  transcript_source VARCHAR(50),
  cache_hit BOOLEAN,
  credits_used INTEGER,
  error_code VARCHAR(50),
  error_message TEXT,
  user_agent VARCHAR(512),
  ip_address VARCHAR(45),
  country_code VARCHAR(2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_requests_user_id ON api_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_api_requests_endpoint ON api_requests(endpoint);
CREATE INDEX IF NOT EXISTS idx_api_requests_status_code ON api_requests(status_code);
CREATE INDEX IF NOT EXISTS idx_api_requests_created_at ON api_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_api_requests_cache_hit ON api_requests(cache_hit);
