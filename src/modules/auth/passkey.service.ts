import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { query } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';

/**
 * Passkeys (WebAuthn / FIDO2) — passwordless, phishing-resistant login.
 *
 * The relying-party ID (rpID) and expected origin are derived from the request
 * host, so a passkey registered on a white-label partner's domain stays scoped
 * to that domain. Challenges are stored server-side for 5 minutes and consumed
 * once (the row id is the opaque "handle" the client echoes back).
 */
const RP_NAME = 'TutiPays';

export interface RpContext { host: string; proto: string }
function rp(ctx: RpContext): { rpID: string; origin: string } {
  const host = ctx.host || 'localhost';
  const rpID = host.split(':')[0] || 'localhost';
  const proto = ctx.proto === 'http' ? 'http' : 'https';
  return { rpID, origin: `${proto}://${host}` };
}

interface ChallengeRow {
  id: string; user_id: string | null; challenge: string; kind: string; rp_id: string; origin: string;
}
async function storeChallenge(userId: string | null, challenge: string, kind: 'register' | 'login', rpID: string, origin: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO webauthn_challenges (user_id, challenge, kind, rp_id, origin, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + interval '5 minutes') RETURNING id`,
    [userId, challenge, kind, rpID, origin],
  );
  return rows[0].id;
}
async function takeChallenge(handle: string, kind: 'register' | 'login'): Promise<ChallengeRow | null> {
  const { rows } = await query<ChallengeRow>(
    `SELECT id, user_id, challenge, kind, rp_id, origin FROM webauthn_challenges
      WHERE id = $1 AND kind = $2 AND expires_at > now()`,
    [handle, kind],
  );
  const c = rows[0];
  if (c) await query('DELETE FROM webauthn_challenges WHERE id = $1', [handle]);
  // Opportunistic cleanup of expired rows.
  await query('DELETE FROM webauthn_challenges WHERE expires_at < now()').catch(() => undefined);
  return c ?? null;
}

const splitTransports = (t: string | null): string[] | undefined => (t ? (t.split(',').filter(Boolean) as string[]) : undefined);

/** Registration options for a signed-in member (to add a passkey). */
export async function registerOptions(userId: string, ctx: RpContext) {
  const { rpID, origin } = rp(ctx);
  const u = (await query<{ username: string | null; email: string | null; phone: string | null; full_name: string | null }>(
    'SELECT username, email, phone, full_name FROM users WHERE id = $1', [userId],
  )).rows[0];
  if (!u) throw ApiError.unauthorized('User not found');
  const userName = u.username || u.email || u.phone || userId;
  const existing = await query<{ credential_id: string; transports: string | null }>(
    'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1', [userId],
  );
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: new TextEncoder().encode(userId),
    userName,
    userDisplayName: u.full_name || userName,
    attestationType: 'none',
    excludeCredentials: existing.rows.map((c) => ({ id: c.credential_id, transports: splitTransports(c.transports) as never })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const handle = await storeChallenge(userId, options.challenge, 'register', rpID, origin);
  return { handle, options };
}

/** Verify a registration response and persist the new credential. */
export async function registerVerify(userId: string, handle: string, response: Record<string, unknown>, deviceName: string | undefined, _ctx: RpContext) {
  const c = await takeChallenge(handle, 'register');
  if (!c || c.user_id !== userId) throw ApiError.unprocessable('Registration challenge expired — please try again');
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as never,
      expectedChallenge: c.challenge,
      expectedOrigin: c.origin,
      expectedRPID: c.rp_id,
      requireUserVerification: false,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'passkey registration verify failed');
    throw ApiError.unprocessable('Passkey registration failed: ' + (err as Error).message);
  }
  if (!verification.verified || !verification.registrationInfo) throw ApiError.unprocessable('Passkey could not be verified');
  const cred = verification.registrationInfo.credential;
  const publicKey = Buffer.from(cred.publicKey).toString('base64url');
  const resp = (response.response as { transports?: string[] } | undefined);
  const transports = (resp?.transports || cred.transports || []).join(',') || null;
  await query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, rp_id, device_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (credential_id) DO NOTHING`,
    [userId, cred.id, publicKey, cred.counter ?? 0, transports, c.rp_id, deviceName || null],
  );
  return { verified: true };
}

/** Authentication options for a login attempt (identifier may be unknown). */
export async function loginOptions(identifier: string, ctx: RpContext) {
  const { rpID, origin } = rp(ctx);
  const userId = identifier
    ? (await query<{ id: string }>(
        `SELECT id FROM users WHERE lower(email) = lower($1) OR phone = $1 OR lower(username) = lower($1) LIMIT 1`,
        [identifier],
      )).rows[0]?.id ?? null
    : null;
  let allow: Array<{ id: string; transports?: string[] }> = [];
  if (userId) {
    const creds = await query<{ credential_id: string; transports: string | null }>(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1', [userId],
    );
    allow = creds.rows.map((c) => ({ id: c.credential_id, transports: splitTransports(c.transports) }));
  }
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: allow as never,
    userVerification: 'preferred',
  });
  const handle = await storeChallenge(userId, options.challenge, 'login', rpID, origin);
  return { handle, options, has_passkeys: allow.length > 0 };
}

/** Verify an authentication response; returns the authenticated user id. */
export async function loginVerify(handle: string, response: Record<string, unknown>, _ctx: RpContext): Promise<string> {
  const c = await takeChallenge(handle, 'login');
  if (!c) throw ApiError.unprocessable('Login challenge expired — please try again');
  const credId = String(response.id || response.rawId || '');
  const cred = (await query<{ id: string; user_id: string; credential_id: string; public_key: string; counter: string; transports: string | null }>(
    'SELECT id, user_id, credential_id, public_key, counter, transports FROM webauthn_credentials WHERE credential_id = $1', [credId],
  )).rows[0];
  if (!cred || (c.user_id && cred.user_id !== c.user_id)) throw ApiError.unauthorized('Passkey not recognised');
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as never,
      expectedChallenge: c.challenge,
      expectedOrigin: c.origin,
      expectedRPID: c.rp_id,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
        counter: Number(cred.counter),
        transports: splitTransports(cred.transports) as never,
      },
      requireUserVerification: false,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'passkey login verify failed');
    throw ApiError.unauthorized('Passkey verification failed');
  }
  if (!verification.verified) throw ApiError.unauthorized('Passkey verification failed');
  await query('UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE id = $2',
    [verification.authenticationInfo.newCounter, cred.id]);
  return cred.user_id;
}

export async function listCredentials(userId: string) {
  const { rows } = await query(
    `SELECT id, device_name, transports, created_at, last_used_at
       FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC`, [userId],
  );
  return rows;
}
export async function deleteCredential(userId: string, id: string): Promise<void> {
  await query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [id, userId]);
}
