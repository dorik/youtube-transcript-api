# Feature: API Key Authentication

**Status:** Not started  
**Priority:** Critical (Tier 1)  
**Est. Effort:** 1 day  
**Dependencies:** Database schema, user table

---

## Overview

This feature implements stateless API key authentication for the REST API. Users receive an API key upon signup, which they use to authenticate all requests via the `Authorization` header.

### Key Principles

- **No sessions:** API keys are stateless (no server-side session state)
- **No password in API:** API keys are separate from login credentials
- **Rotating keys:** Users can regenerate keys without changing password
- **Rate limiting by key:** Each key gets independent rate limits
- **Audit trail:** Every API call logs which key was used

---

## Implementation Plan

### Step 1: API Key Generation

**Goal:** Create cryptographically secure API keys.

**Requirements:**
- Unpredictable (random, not sequential)
- Human-readable (easy to copy-paste)
- Unique (no collisions)
- Revocable (can be disabled)

**Format:** Inspired by Stripe, GitHub tokens

```
yt_live_abc123def456ghi789jkl012mnop
│  │     │
│  │     └─ Random suffix (30 chars, base64-url)
│  └─ Environment (live, test, dev)
└─ Product prefix (yt = YouTube Transcripts)
```

**Implementation:**

```typescript
// src/services/keyGenerator.ts
import crypto from 'crypto';

export function generateApiKey(): { prefix: string; fullKey: string; hash: string } {
  // Generate random suffix (30 chars)
  const randomBytes = crypto.randomBytes(24);
  const suffix = randomBytes.toString('base64').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30);

  const prefix = 'yt_live';
  const fullKey = `${prefix}_${suffix}`;

  // Hash the key for storage (never store plaintext)
  const hash = crypto.createHash('sha256').update(fullKey).digest('hex');

  return { prefix, fullKey, hash };
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function getKeyPrefix(fullKey: string): string {
  // Return first 10 chars after prefix for display
  // yt_live_abc123def456ghi789jkl012mnop
  //          ^^^^^^^^^^
  const parts = fullKey.split('_');
  const suffix = parts[parts.length - 1];
  return suffix.slice(0, 10);
}
```

### Step 2: Key Storage

**Database:**
```sql
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash VARCHAR(255) UNIQUE NOT NULL,
  key_prefix VARCHAR(20),
  name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  expires_at TIMESTAMP,
  is_revoked BOOLEAN DEFAULT FALSE,
  revoked_at TIMESTAMP,
  INDEX idx_key_hash (key_hash),
  INDEX idx_user_id (user_id)
);
```

**Key creation function:**

```typescript
// src/services/apiKeyService.ts
import { db } from '../db';
import { generateApiKey, hashApiKey } from './keyGenerator';

export async function createApiKey(
  userId: string,
  name?: string
): Promise<{ fullKey: string; prefix: string }> {
  const { fullKey, hash } = generateApiKey();
  const keyPrefix = fullKey.split('_').pop().slice(0, 10);

  await db.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)`,
    [userId, hash, keyPrefix, name || 'Default Key']
  );

  return { fullKey, prefix: keyPrefix };
}

export async function getKeyByHash(hash: string) {
  const result = await db.query(
    `SELECT k.*, u.id as user_id 
     FROM api_keys k
     JOIN users u ON k.user_id = u.id
     WHERE k.key_hash = $1 AND k.is_revoked = FALSE`,
    [hash]
  );

  return result.rows[0];
}

export async function updateLastUsed(keyHash: string) {
  await db.query(
    `UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1`,
    [keyHash]
  );
}

export async function revokeApiKey(userId: string, keyId: string) {
  const result = await db.query(
    `UPDATE api_keys 
     SET is_revoked = TRUE, revoked_at = NOW() 
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [keyId, userId]
  );

  return result.rows.length > 0;
}

export async function listUserKeys(userId: string) {
  const result = await db.query(
    `SELECT id, key_prefix, name, created_at, last_used_at, is_revoked
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows;
}
```

### Step 3: Authentication Middleware

**Goal:** Validate API key in every request.

```typescript
// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import { hashApiKey } from '../services/keyGenerator';
import { getKeyByHash, updateLastUsed } from '../services/apiKeyService';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        keyId: string;
      };
      apiKeyPrefix?: string;
    }
  }
}

export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Extract Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Missing or invalid Authorization header. Use: Authorization: Bearer <api_key>',
        code: 'MISSING_API_KEY',
      });
    }

    const apiKey = authHeader.replace('Bearer ', '').trim();

    // Validate key format
    if (!apiKey.startsWith('yt_')) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid API key format',
        code: 'INVALID_API_KEY',
      });
    }

    // Hash key and lookup
    const keyHash = hashApiKey(apiKey);
    const keyRecord = await getKeyByHash(keyHash);

    if (!keyRecord) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid or revoked API key',
        code: 'INVALID_API_KEY',
      });
    }

    // Check if key is expired
    if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'API key has expired',
        code: 'EXPIRED_API_KEY',
      });
    }

    // Update last used timestamp (async, don't wait)
    updateLastUsed(keyHash).catch(err => 
      console.error('Failed to update last_used_at:', err)
    );

    // Attach user to request
    req.user = {
      id: keyRecord.user_id,
      email: keyRecord.email,
      keyId: keyRecord.id,
    };
    req.apiKeyPrefix = keyRecord.key_prefix;

    // Continue
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'Authentication check failed',
      code: 'AUTH_ERROR',
    });
  }
}

// Optional: Alternative for web dashboard (session-based auth)
export async function authenticateSession(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const userId = req.session?.userId;

  if (!userId) {
    return res.status(401).redirect('/login');
  }

  req.user = { id: userId };
  next();
}
```

### Step 4: Error Responses

**Standardized error format:**

```typescript
// src/middleware/errorHandler.ts
export class UnauthorizedError extends Error {
  constructor(message: string, public code: string = 'UNAUTHORIZED') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class InvalidApiKeyError extends UnauthorizedError {
  constructor() {
    super('Invalid or revoked API key', 'INVALID_API_KEY');
  }
}

export class MissingApiKeyError extends UnauthorizedError {
  constructor() {
    super('Missing Authorization header', 'MISSING_API_KEY');
  }
}

// Usage in middleware
if (!authHeader) {
  throw new MissingApiKeyError();
}
```

### Step 5: Key Management Endpoints

**Dashboard API endpoints:**

```typescript
// src/routes/apiKeys.ts
import express from 'express';
import { authenticateSession } from '../middleware/auth';
import { createApiKey, revokeApiKey, listUserKeys } from '../services/apiKeyService';

const router = express.Router();

// List user's API keys
router.get('/keys', authenticateSession, async (req, res) => {
  const keys = await listUserKeys(req.user.id);
  res.json({ keys });
});

// Create new API key
router.post('/keys', authenticateSession, async (req, res) => {
  const { name } = req.body;

  const { fullKey, prefix } = await createApiKey(req.user.id, name);

  res.json({
    key: fullKey,  // Only shown once at creation
    prefix,
    message: 'API key created. Store this somewhere safe—you won\'t be able to see it again.',
  });
});

// Revoke API key
router.delete('/keys/:keyId', authenticateSession, async (req, res) => {
  const success = await revokeApiKey(req.user.id, req.params.keyId);

  if (!success) {
    return res.status(404).json({ error: 'Key not found' });
  }

  res.json({ message: 'API key revoked' });
});

export default router;
```

### Step 6: Logging & Audit Trail

**Goal:** Track every API call with auth info for security audits.

```typescript
// src/middleware/requestLogging.ts
export async function logApiRequest(
  req: Request,
  res: Response,
  duration: number
) {
  await db.query(
    `INSERT INTO api_requests 
     (user_id, api_key_id, method, endpoint, status_code, response_time_ms, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      req.user?.id,
      req.user?.keyId,
      req.method,
      req.path,
      res.statusCode,
      duration,
      req.ip,
    ]
  );
}
```

### Step 7: Key Security Best Practices

**Implementation:**

```typescript
// Automatic key rotation (optional)
export async function rotateExpiredKeys() {
  // Find keys that expire today
  const result = await db.query(
    `SELECT id, user_id FROM api_keys 
     WHERE expires_at = CURRENT_DATE AND is_revoked = FALSE`
  );

  // Auto-revoke and notify user
  for (const key of result.rows) {
    await revokeApiKey(key.user_id, key.id);
    // Send email: "Your API key is expiring in 7 days"
  }
}

// Detect suspicious activity
export async function detectSuspiciousActivity(userId: string) {
  const result = await db.query(
    `SELECT COUNT(*) as request_count 
     FROM api_requests 
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL 1 MINUTE`,
    [userId]
  );

  const requestCount = result.rows[0].request_count;

  if (requestCount > 100) {
    console.warn(`Suspicious activity: User ${userId} made ${requestCount} requests in 1 minute`);
    // Could trigger rate limit or alert
  }
}
```

---

## Testing

### Unit Tests

```typescript
describe('API Key Authentication', () => {
  it('should generate unique API keys', () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();

    expect(key1.fullKey).not.toBe(key2.fullKey);
    expect(key1.hash).not.toBe(key2.hash);
  });

  it('should hash keys consistently', () => {
    const key = 'yt_live_abc123';
    const hash1 = hashApiKey(key);
    const hash2 = hashApiKey(key);

    expect(hash1).toBe(hash2);
  });

  it('should extract key prefix correctly', () => {
    const fullKey = 'yt_live_abc123def456ghi789jkl012mnop';
    const prefix = getKeyPrefix(fullKey);

    expect(prefix).toMatch(/^[a-zA-Z0-9_-]{10}$/);
  });

  it('should reject missing Authorization header', async () => {
    const res = await request(app).get('/v1/transcript');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_API_KEY');
  });

  it('should reject invalid API key', async () => {
    const res = await request(app)
      .get('/v1/transcript')
      .set('Authorization', 'Bearer invalid_key');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_API_KEY');
  });

  it('should accept valid API key', async () => {
    const { fullKey } = await createApiKey(userId);

    const res = await request(app)
      .get('/v1/transcript')
      .set('Authorization', `Bearer ${fullKey}`)
      .query({ url: 'https://youtu.be/abc123' });

    expect(res.status).not.toBe(401);
  });

  it('should reject revoked keys', async () => {
    const { fullKey } = await createApiKey(userId);
    const keyId = await getKeyIdByPrefix(fullKey.split('_').pop());

    await revokeApiKey(userId, keyId);

    const res = await request(app)
      .get('/v1/transcript')
      .set('Authorization', `Bearer ${fullKey}`)
      .query({ url: 'https://youtu.be/abc123' });

    expect(res.status).toBe(401);
  });
});
```

### Integration Tests

```typescript
describe('Authentication Integration', () => {
  it('should track API usage per key', async () => {
    const { fullKey } = await createApiKey(userId);

    // Make 5 requests
    for (let i = 0; i < 5; i++) {
      await request(app)
        .get('/v1/transcript')
        .set('Authorization', `Bearer ${fullKey}`)
        .query({ url: 'https://youtu.be/abc123' });
    }

    // Check audit log
    const result = await db.query(
      `SELECT COUNT(*) as count FROM api_requests WHERE api_key_id = $1`,
      [keyId]
    );

    expect(result.rows[0].count).toBe(5);
  });
});
```

---

## Security Considerations

| Risk | Mitigation |
|------|-----------|
| **Key theft** | Store hash, not plaintext; HTTPS only |
| **Brute force** | Rate limit auth failures; monitor for patterns |
| **Key leakage in logs** | Never log full keys, only prefix |
| **Session fixation** | Use long random suffixes (256-bit entropy) |
| **Man-in-the-middle** | Enforce HTTPS in production |

---

## Deployment Checklist

- [ ] HTTPS enabled (API keys transmitted over encrypted connection only)
- [ ] Rate limiting on auth failures configured
- [ ] Key generation tested (uniqueness verified)
- [ ] Database hashing strategy confirmed (SHA-256)
- [ ] Audit logging enabled
- [ ] Key expiration policy decided (optional)
- [ ] Monitoring for suspicious activity set up

---

## User Documentation

**Getting your API key:**
1. Sign up at https://youtubetranscripts.co
2. Go to Dashboard → API Keys
3. Click "Create Key"
4. Copy the key (shown only once)
5. Use in requests: `Authorization: Bearer yt_live_...`

**Keeping keys safe:**
- Never commit keys to Git
- Use environment variables: `YOUTUBE_API_KEY=yt_live_...`
- Rotate keys periodically
- Revoke unused keys immediately

---

**Status:** Ready for implementation  
**Version:** 1.0  
**Last Updated:** 2026-05-09
