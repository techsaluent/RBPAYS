import { PoolClient } from 'pg';
import ms from '../../utils/ms';
import { query, withTransaction } from '../../../db';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ApiError } from '../../utils/ApiError';
import {
  generateRefreshToken,
  hashToken,
  signAccessToken,
} from '../../utils/jwt';
import { hashPassword, verifyPassword } from '../../utils/password';
import { LoginInput, SignupInput } from './auth.schemas';

export interface PublicUser {
  id: string;
  full_name: string;
  username: string | null;
  email: string;
  phone: string;
  role: string;
  status: string;
  kyc_status: string;
  created_at: string;
}

interface UserRow extends PublicUser {
  password_hash: string;
  mpin_hash?: string | null;
}

const PUBLIC_COLUMNS =
  'id, full_name, username, email, phone, role, status, kyc_status, created_at';

function toTokens(user: PublicUser) {
  return {
    access_token: signAccessToken({ sub: user.id, role: user.role }),
    token_type: 'Bearer',
    expires_in: env.JWT_ACCESS_TTL,
  };
}

async function issueRefreshToken(
  client: PoolClient,
  userId: string,
): Promise<string> {
  const { token, tokenHash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + ms(env.JWT_REFRESH_TTL));
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  );
  return token;
}

export async function signup(input: SignupInput) {
  const password_hash = await hashPassword(input.password);

  return withTransaction(async (client) => {
    // Uniqueness is also enforced by DB indexes; check first for a clean error.
    const dupe = await client.query(
      `SELECT 1 FROM users
        WHERE lower(email) = lower($1) OR phone = $2
           OR ($3::text IS NOT NULL AND lower(username) = lower($3))
        LIMIT 1`,
      [input.email, input.phone, input.username ?? null],
    );
    if (dupe.rowCount) {
      throw ApiError.conflict('A user with this email, phone or username already exists');
    }

    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (full_name, email, phone, username, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PUBLIC_COLUMNS}`,
      [input.full_name, input.email, input.phone, input.username ?? null, password_hash],
    );
    const user = rows[0];

    // Every user gets a wallet on signup.
    await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [user.id]);

    const refresh_token = await issueRefreshToken(client, user.id);
    return { user, ...toTokens(user), refresh_token };
  });
}

export async function login(input: LoginInput) {
  const { rows } = await query<UserRow>(
    `SELECT ${PUBLIC_COLUMNS}, password_hash, mpin_hash
       FROM users
      WHERE lower(email) = lower($1) OR phone = $1 OR lower(username) = lower($1)
      LIMIT 1`,
    [input.identifier],
  );
  const user = rows[0];

  // Constant-ish behaviour: always run a compare to reduce user enumeration.
  const ok = user
    ? await verifyPassword(input.password, user.password_hash)
    : await verifyPassword(input.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinv');

  if (!user || !ok) {
    throw ApiError.unauthorized('Invalid credentials');
  }
  if (user.status !== 'active') {
    throw ApiError.forbidden(`Account is ${user.status}`);
  }

  // MPIN second factor: when the account has an MPIN, it must be supplied.
  if (user.mpin_hash) {
    if (!input.mpin) {
      throw new ApiError(401, 'mpin_required', 'MPIN required');
    }
    const mpinOk = await verifyPassword(input.mpin, user.mpin_hash);
    if (!mpinOk) throw ApiError.unauthorized('Invalid MPIN');
  }

  const { password_hash, mpin_hash, ...publicUser } = user;
  void password_hash;
  void mpin_hash;

  return withTransaction(async (client) => {
    const refresh_token = await issueRefreshToken(client, publicUser.id);
    return { user: publicUser, ...toTokens(publicUser), refresh_token, mpin_set: !!user.mpin_hash };
  });
}

// ---------------------------------------------------------------------
// Account security: password change, MPIN, forgot/reset password
// ---------------------------------------------------------------------
async function verifyCurrentPassword(userId: string, currentPassword: string): Promise<void> {
  const { rows } = await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
    throw ApiError.unauthorized('Current password is incorrect');
  }
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  await verifyCurrentPassword(userId, currentPassword);
  const hash = await hashPassword(newPassword);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
  // Revoke existing sessions after a password change.
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export async function setMpin(userId: string, currentPassword: string, mpin: string): Promise<void> {
  await verifyCurrentPassword(userId, currentPassword);
  const hash = await hashPassword(mpin);
  await query('UPDATE users SET mpin_hash = $1 WHERE id = $2', [hash, userId]);
}

export async function removeMpin(userId: string, currentPassword: string): Promise<void> {
  await verifyCurrentPassword(userId, currentPassword);
  await query('UPDATE users SET mpin_hash = NULL WHERE id = $1', [userId]);
}

export async function mpinStatus(userId: string): Promise<{ mpin_set: boolean }> {
  const { rows } = await query<{ mpin_hash: string | null }>('SELECT mpin_hash FROM users WHERE id = $1', [userId]);
  return { mpin_set: !!rows[0]?.mpin_hash };
}

/** Admin resets a member's password (immediate). */
export async function adminResetPassword(userId: string, newPassword: string): Promise<void> {
  const hash = await hashPassword(newPassword);
  const { rowCount } = await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
  if (!rowCount) throw ApiError.notFound('User not found');
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

/**
 * Start a forgot-password flow: create a 6-digit code (hashed, 15-min TTL).
 * Delivery goes through the configured SMS/email integration; when none is
 * active the code is logged server-side, and in non-production returned in the
 * response so it is testable. Always responds generically to avoid enumeration.
 */
export async function forgotPassword(identifier: string): Promise<{ delivered: boolean; dev_code?: string }> {
  const { rows } = await query<{ id: string; phone: string; email: string }>(
    `SELECT id, phone, email FROM users
      WHERE lower(email) = lower($1) OR phone = $1 OR lower(username) = lower($1) LIMIT 1`,
    [identifier],
  );
  const user = rows[0];
  if (!user) return { delivered: false };

  const realCode = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await hashPassword(realCode);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await query(
    'INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES ($1,$2,$3)',
    [user.id, codeHash, expiresAt],
  );
  // Delivery goes through the configured SMS/email integration once wired.
  // Until then the code is logged; in non-production it is also returned.
  logger.info({ userId: user.id, code: env.isProd ? undefined : realCode }, 'password reset code generated');
  return { delivered: false, dev_code: env.isProd ? undefined : realCode };
}

export async function resetPassword(identifier: string, code: string, newPassword: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1) OR phone = $1 OR lower(username) = lower($1) LIMIT 1`,
    [identifier],
  );
  const user = rows[0];
  if (!user) throw ApiError.unauthorized('Invalid code');

  const resets = await query<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM password_resets
      WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 5`,
    [user.id],
  );
  let matchId: string | null = null;
  for (const r of resets.rows) {
    if (await verifyPassword(code, r.code_hash)) { matchId = r.id; break; }
  }
  if (!matchId) throw ApiError.unauthorized('Invalid or expired code');

  const hash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    await client.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [matchId]);
    await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
  });
}

/** Rotate a refresh token: revoke the presented one, issue a fresh pair. */
export async function refresh(rawToken: string) {
  const tokenHash = hashToken(rawToken);

  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      user_id: string;
      expires_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, user_id, expires_at, revoked_at
         FROM refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [tokenHash],
    );
    const record = rows[0];
    if (!record || record.revoked_at || new Date(record.expires_at) < new Date()) {
      throw ApiError.unauthorized('Invalid or expired refresh token');
    }

    await client.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1',
      [record.id],
    );

    const userRes = await client.query<UserRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`,
      [record.user_id],
    );
    const user = userRes.rows[0];
    if (!user) throw ApiError.unauthorized('User no longer exists');

    const refresh_token = await issueRefreshToken(client, user.id);
    return { user, ...toTokens(user), refresh_token };
  });
}

export async function logout(rawToken: string): Promise<void> {
  await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(rawToken)],
  );
}

export async function getUserById(id: string): Promise<PublicUser> {
  const { rows } = await query<PublicUser>(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw ApiError.notFound('User not found');
  return rows[0];
}
