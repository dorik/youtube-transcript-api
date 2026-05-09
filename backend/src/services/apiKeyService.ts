import crypto from 'crypto';
import { pool } from '../db/pool';
import { NotFoundError } from '../utils/errors';

const KEY_PREFIX = 'yt_live';

export interface ApiKeyRow {
  id: string;
  user_id: string;
  key_prefix: string | null;
  name: string | null;
  created_at: Date;
  last_used_at: Date | null;
  is_revoked: boolean;
}

export interface ApiKeyResolved {
  apiKeyId: string;
  userId: string;
  email: string;
}

/**
 * Generate a new API key. We return the plaintext key once (caller shows it
 * to the user) and store only the sha256 hash. Format: `yt_live_<24 random bytes b64url>`.
 */
export function generateApiKey(): { fullKey: string; hash: string; displayPrefix: string } {
  const random = crypto.randomBytes(24).toString('base64url'); // ~32 chars
  const fullKey = `${KEY_PREFIX}_${random}`;
  const hash = sha256(fullKey);
  const displayPrefix = random.slice(0, 8);
  return { fullKey, hash, displayPrefix };
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export async function createApiKey(userId: string, name?: string) {
  const { fullKey, hash, displayPrefix } = generateApiKey();
  const { rows } = await pool.query<ApiKeyRow>(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, key_prefix, name, created_at, last_used_at, is_revoked`,
    [userId, hash, displayPrefix, name ?? 'Default Key'],
  );
  return { key: rows[0], plaintext: fullKey };
}

export async function listApiKeys(userId: string): Promise<ApiKeyRow[]> {
  const { rows } = await pool.query<ApiKeyRow>(
    `SELECT id, user_id, key_prefix, name, created_at, last_used_at, is_revoked
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function revokeApiKey(userId: string, keyId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE api_keys
     SET is_revoked = TRUE, revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_revoked = FALSE`,
    [keyId, userId],
  );
  if (!rowCount) {
    throw new NotFoundError('API key not found or already revoked', 'KEY_NOT_FOUND');
  }
}

/**
 * Look up a plaintext API key. Returns the user id + key id, or null if no
 * match (revoked, expired, or wrong key).
 */
export async function resolveApiKey(plaintext: string): Promise<ApiKeyResolved | null> {
  const hash = sha256(plaintext);
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    email: string;
    is_revoked: boolean;
    expires_at: Date | null;
    is_suspended: boolean;
  }>(
    `SELECT k.id, k.user_id, u.email, k.is_revoked, k.expires_at, u.is_suspended
     FROM api_keys k
     JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.is_revoked || row.is_suspended) return null;
  if (row.expires_at && row.expires_at < new Date()) return null;
  return { apiKeyId: row.id, userId: row.user_id, email: row.email };
}

/**
 * Update last-used timestamp. Fire-and-forget; we don't block the request on
 * this write.
 */
export async function touchApiKey(keyId: string): Promise<void> {
  await pool
    .query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [keyId])
    .catch(() => {
      /* swallow: best-effort timestamp update */
    });
}
