import { withTransaction, pool } from '../db/pool';
import { hashPassword } from '../utils/password';
import { ConflictError, NotFoundError } from '../utils/errors';

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  is_suspended: boolean;
  created_at: Date;
  last_login_at: Date | null;
}

export interface UserWithPassword extends User {
  password_hash: string;
}

const FREE_PLAN = {
  id: 'free',
  name: 'Free',
  monthlyCredits: 100,
};

/**
 * Create a user with the Free plan and a 100-credit starter balance.
 *
 * All three rows (users, subscriptions, credits) are inserted in one
 * transaction so partial signups can never happen.
 */
export async function createUser(
  email: string,
  password: string,
  displayName?: string,
): Promise<User> {
  const passwordHash = await hashPassword(password);
  const lowercaseEmail = email.toLowerCase().trim();

  return withTransaction(async (client) => {
    // Check duplicate
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1',
      [lowercaseEmail],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');
    }

    const userResult = await client.query<User>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, is_active, is_suspended, created_at, last_login_at`,
      [lowercaseEmail, passwordHash, displayName ?? null],
    );
    const user = userResult.rows[0];

    // 30-day cycle starting now
    const cycleEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO subscriptions
         (user_id, plan_id, plan_name, monthly_credits, billing_cycle_start, billing_cycle_end, status)
       VALUES ($1, $2, $3, $4, NOW(), $5, 'active')`,
      [user.id, FREE_PLAN.id, FREE_PLAN.name, FREE_PLAN.monthlyCredits, cycleEnd],
    );

    await client.query(
      `INSERT INTO credits (user_id, balance, total_allocated, last_reset_at, next_reset_at)
       VALUES ($1, $2, $2, NOW(), $3)`,
      [user.id, FREE_PLAN.monthlyCredits, cycleEnd],
    );

    return user;
  });
}

export async function getUserByEmail(email: string): Promise<UserWithPassword | null> {
  const { rows } = await pool.query<UserWithPassword>(
    `SELECT id, email, password_hash, display_name, is_active, is_suspended, created_at, last_login_at
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()],
  );
  return rows[0] ?? null;
}

export async function getUserById(id: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    `SELECT id, email, display_name, is_active, is_suspended, created_at, last_login_at
     FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getUserByIdRequired(id: string): Promise<User> {
  const user = await getUserById(id);
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
  return user;
}

export async function recordLogin(userId: string): Promise<void> {
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);
}
