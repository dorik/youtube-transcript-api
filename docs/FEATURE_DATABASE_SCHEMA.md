# Feature: Database Schema (PostgreSQL)

**Status:** Not started  
**Priority:** Critical (Tier 1)  
**Est. Effort:** 1 day  
**Dependencies:** None (foundational)

---

## Overview

This document defines the PostgreSQL schema for the YouTube Transcripts API. It stores user accounts, API keys, billing information, cached transcripts, usage logs, and system metrics.

---

## Schema Design

### Table 1: users

**Purpose:** Core user accounts.

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  is_suspended BOOLEAN DEFAULT FALSE,
  suspension_reason TEXT,
  suspended_at TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_created_at (created_at)
);
```

**Rationale:**
- `id`: UUID for security (not sequential)
- `email`: Unique identifier for signup/login
- `password_hash`: Never store plaintext (bcrypt/argon2)
- `is_suspended`: Admin control for abuse
- Indexes on frequently queried columns (email, created_at)

---

### Table 2: api_keys

**Purpose:** Authentication tokens for API access.

```sql
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash VARCHAR(255) UNIQUE NOT NULL,
  key_prefix VARCHAR(20),  -- For display (first 10 chars)
  name VARCHAR(255),       -- User-friendly label (e.g., "Production", "Development")
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  expires_at TIMESTAMP,    -- NULL = never expires
  is_revoked BOOLEAN DEFAULT FALSE,
  revoked_at TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_key_hash (key_hash)
);
```

**Rationale:**
- `key_hash`: Never store plaintext API keys (use bcrypt hash)
- `key_prefix`: Show first 10 chars in UI for user reference
- `name`: Let users label keys (helpful for multi-env setups)
- `last_used_at`: Track activity, detect stale keys
- `expires_at`: Optional key rotation/expiry

---

### Table 3: subscriptions

**Purpose:** User billing plans and credit allocations.

```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id VARCHAR(50) NOT NULL,  -- 'free', 'starter', 'pro', 'business', 'scale'
  plan_name VARCHAR(255) NOT NULL,
  monthly_credits INT NOT NULL,  -- e.g., 100, 2500, 12000
  billing_cycle_start TIMESTAMP NOT NULL,
  billing_cycle_end TIMESTAMP NOT NULL,
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  status VARCHAR(50) DEFAULT 'active',  -- 'active', 'past_due', 'cancelled', 'paused'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  cancelled_at TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_stripe_customer_id (stripe_customer_id),
  INDEX idx_status (status)
);
```

**Rationale:**
- One subscription per user (user_id UNIQUE)
- `plan_id`: Machine-readable identifier for pricing tier
- `monthly_credits`: Resets each billing cycle
- `billing_cycle_*`: When credits reset
- `stripe_*`: Links to Stripe for payment processing
- `status`: Track subscription state (past_due if payment failed)

---

### Table 4: credits

**Purpose:** Track credit balance and transactions.

```sql
CREATE TABLE credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance INT NOT NULL DEFAULT 0,  -- Current credit balance
  total_allocated INT DEFAULT 0,   -- Total credits ever assigned (monthly)
  total_used INT DEFAULT 0,        -- Total credits ever used
  last_reset_at TIMESTAMP,         -- When monthly credits last reset
  next_reset_at TIMESTAMP,         -- When monthly credits next reset
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id)
);
```

**Rationale:**
- Single row per user (fast lookups)
- `balance`: Current usable credits
- `total_allocated`: Lifetime monthly allowance
- `total_used`: Lifetime usage
- `last_reset_at`: For debugging/auditing

---

### Table 5: credit_transactions

**Purpose:** Audit log of all credit movements.

```sql
CREATE TABLE credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INT NOT NULL,  -- Positive = add, negative = deduct
  reason VARCHAR(50) NOT NULL,  -- 'monthly_allocation', 'transcript_fetch', 'whisper_transcription', 'refund', 'admin_adjustment'
  related_type VARCHAR(50),  -- 'video', 'subscription', 'support', etc.
  related_id VARCHAR(255),   -- video_id, subscription_id, etc.
  video_id VARCHAR(11),      -- For transcript fetches
  source VARCHAR(50),        -- 'native_captions', 'whisper'
  duration_seconds INT,      -- For Whisper-based deductions
  metadata JSONB,            -- Flexible storage (error details, proxy info, etc.)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at),
  INDEX idx_reason (reason),
  INDEX idx_video_id (video_id)
);
```

**Rationale:**
- Immutable audit trail (INSERT only, never UPDATE)
- `reason`: Track why credits moved
- `video_id`: Link to transcript request
- `metadata`: Extensible for future data (errors, etc.)
- Multiple indexes for auditing and debugging

---

### Table 6: cached_transcripts

**Purpose:** Cache fetched transcripts for fast retrieval.

```sql
CREATE TABLE cached_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id VARCHAR(11) NOT NULL,
  url VARCHAR(255),
  language VARCHAR(10) DEFAULT 'en',
  title VARCHAR(512),
  channel VARCHAR(255),
  duration_seconds INT,
  upload_date DATE,
  source VARCHAR(50),  -- 'native_captions', 'whisper'
  
  -- Full transcript
  transcript_text TEXT NOT NULL,
  
  -- Segments (JSON for flexibility)
  segments JSONB NOT NULL,  -- Array of {start, duration, text}
  
  -- Metadata
  character_count INT,
  segment_count INT,
  
  -- Cache management
  first_cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  access_count INT DEFAULT 1,
  expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
  
  -- Indexes
  PRIMARY KEY (video_id, language),
  INDEX idx_video_id (video_id),
  INDEX idx_expires_at (expires_at),
  INDEX idx_access_count (access_count)
);
```

**Rationale:**
- Composite primary key (video_id + language)
- `segments`: Stored as JSONB for flexible querying (future)
- `expires_at`: Cleanup old entries (cron job)
- `access_count`: Track popular videos
- `last_accessed_at`: Identify stale cache entries

---

### Table 7: api_requests

**Purpose:** Logging all API requests for analytics and debugging.

```sql
CREATE TABLE api_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  
  -- Request details
  method VARCHAR(10) NOT NULL,  -- GET, POST, etc.
  endpoint VARCHAR(255) NOT NULL,  -- /v1/transcript
  status_code INT NOT NULL,
  
  -- Query parameters
  video_url VARCHAR(255),
  format VARCHAR(50),
  language VARCHAR(10),
  
  -- Response details
  response_time_ms INT,
  transcript_source VARCHAR(50),
  cache_hit BOOLEAN,
  
  -- Error tracking
  error_code VARCHAR(50),
  error_message TEXT,
  
  -- Client info
  user_agent VARCHAR(512),
  ip_address VARCHAR(45),  -- IPv4 or IPv6
  country_code VARCHAR(2),
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- Indexes
  INDEX idx_user_id (user_id),
  INDEX idx_endpoint (endpoint),
  INDEX idx_status_code (status_code),
  INDEX idx_created_at (created_at),
  INDEX idx_cache_hit (cache_hit)
);
```

**Rationale:**
- Comprehensive request logging for debugging
- `response_time_ms`: Performance monitoring
- `cache_hit`: Track cache effectiveness
- `country_code`: Future geo-blocking or analytics
- Generous TTL for logs (archive/delete after 90 days)

---

### Table 8: youtube_metadata_cache

**Purpose:** Cache YouTube video metadata (title, duration, etc.).

```sql
CREATE TABLE youtube_metadata_cache (
  video_id VARCHAR(11) PRIMARY KEY,
  title VARCHAR(512),
  channel VARCHAR(255),
  channel_id VARCHAR(255),
  upload_date DATE,
  duration_seconds INT,
  view_count BIGINT,
  like_count INT,
  thumbnail_url VARCHAR(512),
  is_age_restricted BOOLEAN DEFAULT FALSE,
  
  -- Cache management
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '90 days'),
  
  INDEX idx_expires_at (expires_at)
);
```

**Rationale:**
- Fast metadata lookups without fetching from YouTube each time
- Longer TTL (90 days) since metadata doesn't change often

---

### Table 9: billing_events

**Purpose:** Track Stripe webhook events and payment processing.

```sql
CREATE TABLE billing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
  event_type VARCHAR(100),  -- 'payment_intent.succeeded', 'charge.failed', 'customer.subscription.updated'
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  amount_cents INT,  -- In cents for precision
  currency VARCHAR(3) DEFAULT 'USD',
  status VARCHAR(50),  -- 'succeeded', 'failed', 'pending'
  
  -- Credits issued
  credits_issued INT,
  
  -- Details
  metadata JSONB,  -- Stripe webhook data
  processed BOOLEAN DEFAULT FALSE,
  processed_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_user_id (user_id),
  INDEX idx_stripe_event_id (stripe_event_id),
  INDEX idx_processed (processed),
  INDEX idx_created_at (created_at)
);
```

**Rationale:**
- Track all billing events for reconciliation
- `processed`: Flag for webhook retry logic
- `metadata`: Store full Stripe webhook payload for debugging
- Immutable (INSERT only)

---

### Table 10: system_metrics

**Purpose:** Track system-wide performance and usage metrics.

```sql
CREATE TABLE system_metrics (
  id BIGSERIAL PRIMARY KEY,
  metric_name VARCHAR(100) NOT NULL,
  metric_value FLOAT NOT NULL,
  metadata JSONB,  -- Additional context
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_metric_name (metric_name),
  INDEX idx_created_at (created_at)
);
```

**Example metrics:**
```
- youtube_fetch_success_rate: 95.2
- whisper_fallback_rate: 4.8
- cache_hit_rate: 87.3
- avg_response_time_ms: 245
- proxy_rotation_count: 1523
```

**Rationale:**
- Flexible schema for different metric types
- Time-series friendly (created_at for graphing)
- Easy to query for dashboards

---

## Indexes & Performance Optimization

### Critical Indexes (Must Have)

```sql
-- Authentication (API key lookup)
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);

-- User credit balance (frequent query)
CREATE INDEX idx_credits_user_id ON credits(user_id);

-- Transcript cache lookup
CREATE INDEX idx_cached_transcripts_video_language 
ON cached_transcripts(video_id, language);

-- Audit trail queries
CREATE INDEX idx_credit_transactions_user_created 
ON credit_transactions(user_id, created_at DESC);

-- Request logging (analytics)
CREATE INDEX idx_api_requests_created_user 
ON api_requests(created_at DESC, user_id);
```

### Query Optimization Tips

- Use JSONB indexes for common metadata queries
- Partition `api_requests` by month if it grows large (>100M rows)
- Archive old logs to separate table after 90 days
- Vacuum `cached_transcripts` weekly to clean expired entries

---

## Migrations & Versioning

**Use a migration tool:** Flyway, Alembic (Python), or node-migrate (Node.js)

**Migration naming convention:**
```
V001__create_users_table.sql
V002__create_api_keys_table.sql
V003__create_subscriptions_table.sql
V004__create_credits_tables.sql
V005__create_cached_transcripts_table.sql
V006__create_api_requests_table.sql
V007__add_indexes_for_performance.sql
V008__add_youtube_metadata_cache.sql
V009__add_billing_events.sql
V010__add_system_metrics.sql
```

**Rollback strategy:**
- Write DOWN migration for each UP migration
- Test rollbacks in staging before deploying

---

## Sample Queries

### User Signup Flow

```sql
-- Insert user
INSERT INTO users (email, password_hash, display_name)
VALUES ('user@example.com', '$2b$12$...', 'John Doe')
RETURNING id;

-- Create free subscription
INSERT INTO subscriptions (user_id, plan_id, plan_name, monthly_credits, billing_cycle_start, billing_cycle_end)
VALUES (user_id, 'free', 'Free', 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days')
RETURNING id;

-- Initialize credits
INSERT INTO credits (user_id, balance, total_allocated, last_reset_at, next_reset_at)
VALUES (user_id, 100, 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days');
```

### Check Credit Balance

```sql
SELECT balance FROM credits WHERE user_id = $1;
```

### Deduct Credits (Transaction)

```sql
BEGIN;
  UPDATE credits SET balance = balance - $1 WHERE user_id = $2;
  INSERT INTO credit_transactions (user_id, amount, reason, video_id, source)
  VALUES ($2, -$1, 'transcript_fetch', $3, $4);
COMMIT;
```

### Get User's Recent API Usage

```sql
SELECT 
  COUNT(*) as request_count,
  AVG(response_time_ms) as avg_response_ms,
  SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) as cache_hits,
  SUM(CASE WHEN status_code = 200 THEN 1 ELSE 0 END) as successful_requests
FROM api_requests
WHERE user_id = $1
  AND created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
GROUP BY user_id;
```

### Get Usage Statistics

```sql
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total_requests,
  COUNT(DISTINCT user_id) as active_users,
  SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) as cache_hits,
  AVG(response_time_ms) as avg_response_ms
FROM api_requests
WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

### Find Stale Cached Transcripts

```sql
SELECT video_id, last_accessed_at, access_count
FROM cached_transcripts
WHERE expires_at < CURRENT_TIMESTAMP
ORDER BY last_accessed_at ASC
LIMIT 100;
```

---

## Data Retention & Cleanup

**Implement scheduled jobs:**

```sql
-- Clean up expired cache (nightly)
DELETE FROM cached_transcripts
WHERE expires_at < CURRENT_TIMESTAMP;

-- Archive old API requests (monthly)
INSERT INTO api_requests_archive
SELECT * FROM api_requests
WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days';

DELETE FROM api_requests
WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days';
```

---

## Testing

### Unit Tests (Schema Validation)

```typescript
describe('Database Schema', () => {
  it('should create users table with proper constraints', async () => {
    const result = await db.query(`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'users'
    `);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.find(r => r.column_name === 'email').is_nullable).toBe('NO');
  });

  it('should enforce unique email constraint', async () => {
    await db.query(`INSERT INTO users (email, password_hash) VALUES ('test@example.com', 'hash')`);
    expect(async () => {
      await db.query(`INSERT INTO users (email, password_hash) VALUES ('test@example.com', 'hash')`);
    }).rejects.toThrow();
  });

  it('should cascade delete user subscriptions on user delete', async () => {
    const userId = 'test-id';
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'test@example.com', 'hash')`, [userId]);
    await db.query(`INSERT INTO subscriptions (user_id, plan_id, monthly_credits) VALUES ($1, 'free', 100)`, [userId]);
    
    await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    
    const result = await db.query(`SELECT * FROM subscriptions WHERE user_id = $1`, [userId]);
    expect(result.rows.length).toBe(0);
  });
});
```

---

## Deployment Checklist

- [ ] Database created in PostgreSQL
- [ ] All tables migrated with Flyway/Alembic
- [ ] Indexes created for performance
- [ ] Backup strategy configured (daily snapshots)
- [ ] Monitoring/alerting on table sizes and query performance
- [ ] Test data loaded for QA
- [ ] Connection pooling configured (PgBouncer)

---

**Status:** Ready for implementation  
**Version:** 1.0  
**Last Updated:** 2026-05-09
