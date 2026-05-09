import { pool, withTransaction } from '../db/pool';
import { PaymentRequiredError } from '../utils/errors';

export interface CreditState {
  balance: number;
  total_allocated: number;
  total_used: number;
  last_reset_at: Date | null;
  next_reset_at: Date | null;
}

/**
 * Read-only balance. If the user somehow doesn't have a credits row yet
 * (shouldn't happen — signup always inserts one), we treat them as zero.
 */
export async function getCreditState(userId: string): Promise<CreditState> {
  const { rows } = await pool.query<CreditState>(
    `SELECT balance, total_allocated, total_used, last_reset_at, next_reset_at
     FROM credits WHERE user_id = $1`,
    [userId],
  );
  return (
    rows[0] ?? {
      balance: 0,
      total_allocated: 0,
      total_used: 0,
      last_reset_at: null,
      next_reset_at: null,
    }
  );
}

export interface DeductInput {
  userId: string;
  amount: number;
  reason: string; // e.g. 'transcript_fetch'
  videoId?: string;
  source?: string; // 'native_captions' | 'whisper'
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Atomically deduct credits and append an audit row to credit_transactions.
 *
 * Throws `PaymentRequiredError` if the balance is insufficient. Both rows are
 * inside a single transaction so partial deductions are impossible.
 */
export async function deductCredits(input: DeductInput): Promise<{ balanceAfter: number }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ balance: number }>(
      'SELECT balance FROM credits WHERE user_id = $1 FOR UPDATE',
      [input.userId],
    );
    const balance = rows[0]?.balance ?? 0;
    if (balance < input.amount) {
      throw new PaymentRequiredError(input.amount, balance);
    }
    const balanceAfter = balance - input.amount;

    await client.query(
      `UPDATE credits
       SET balance = $1,
           total_used = total_used + $2,
           updated_at = NOW()
       WHERE user_id = $3`,
      [balanceAfter, input.amount, input.userId],
    );

    await client.query(
      `INSERT INTO credit_transactions
        (user_id, amount, reason, video_id, source, duration_seconds, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.userId,
        -input.amount,
        input.reason,
        input.videoId ?? null,
        input.source ?? null,
        input.durationSeconds ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );

    return { balanceAfter };
  });
}

/**
 * Apply a positive credit grant (monthly reset, refund, manual adjustment).
 */
export async function grantCredits(
  userId: string,
  amount: number,
  reason: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE credits
       SET balance = balance + $1,
           total_allocated = total_allocated + $1,
           updated_at = NOW()
       WHERE user_id = $2`,
      [amount, userId],
    );
    await client.query(
      `INSERT INTO credit_transactions (user_id, amount, reason, metadata)
       VALUES ($1, $2, $3, $4)`,
      [userId, amount, reason, metadata ? JSON.stringify(metadata) : null],
    );
  });
}
