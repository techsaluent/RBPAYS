import { PoolClient } from 'pg';
import ms from '../../utils/ms';
import { query, withTransaction } from '../../../db';
import { env } from '../../config/env';
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
  email: string;
  phone: string;
  role: string;
  status: string;
  kyc_status: string;
  created_at: string;
}

interface UserRow extends PublicUser {
  password_hash: string;
}

const PUBLIC_COLUMNS =
  'id, full_name, email, phone, role, status, kyc_status, created_at';

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
      'SELECT 1 FROM users WHERE lower(email) = lower($1) OR phone = $2 LIMIT 1',
      [input.email, input.phone],
    );
    if (dupe.rowCount) {
      throw ApiError.conflict('A user with this email or phone already exists');
    }

    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (full_name, email, phone, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_COLUMNS}`,
      [input.full_name, input.email, input.phone, password_hash],
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
    `SELECT ${PUBLIC_COLUMNS}, password_hash
       FROM users
      WHERE lower(email) = lower($1) OR phone = $1
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

  const { password_hash, ...publicUser } = user;
  void password_hash;

  return withTransaction(async (client) => {
    const refresh_token = await issueRefreshToken(client, publicUser.id);
    return { user: publicUser, ...toTokens(publicUser), refresh_token };
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
