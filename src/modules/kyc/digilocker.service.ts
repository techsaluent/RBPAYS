import crypto from 'crypto';
import { query, withTransaction } from '../../../db';
import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { decryptSecret } from '../../utils/secretCrypto';

/**
 * DigiLocker e-KYC via API Setu — official government OAuth 2.0 with PKCE.
 *
 * Flow: startAuth() mints a state + PKCE verifier, stores them, and returns the
 * authorize URL. The member authenticates on DigiLocker and is redirected back
 * to our callback with a code; handleCallback() exchanges it for the member's
 * verified identity (name/DOB/gender) and records a verified KYC document.
 *
 * Credentials live in platform_integrations key 'digilocker':
 *   api_key    = Client ID (from the DigiLocker Partner portal)
 *   api_secret = Client Secret (encrypted at rest)
 *   base_url   = https://digilocker.meripehchaan.gov.in (default)
 *   extra.redirect_uri = the EXACT redirect URI registered with DigiLocker
 *                        (defaults to <api>/api/v1/digilocker/callback)
 */
const DEFAULT_BASE = 'https://digilocker.meripehchaan.gov.in';

interface DigiConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  redirectUri?: string;
}

async function config(): Promise<DigiConfig | null> {
  const { rows } = await query<{
    api_key: string | null; api_secret: string | null; base_url: string | null;
    is_active: boolean; extra: Record<string, unknown> | null;
  }>("SELECT api_key, api_secret, base_url, is_active, extra FROM platform_integrations WHERE key = 'digilocker'");
  const r = rows[0];
  if (!r || !r.is_active) return null;
  const clientId = (r.api_key || '').trim();
  const clientSecret = (decryptSecret(r.api_secret) || '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    baseUrl: (r.base_url || DEFAULT_BASE).replace(/\/+$/, ''),
    redirectUri: typeof r.extra?.redirect_uri === 'string' ? (r.extra.redirect_uri as string) : undefined,
  };
}

/** Whether DigiLocker e-KYC is configured and active. */
export async function digilockerEnabled(): Promise<boolean> {
  return (await config()) !== null;
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Begin a DigiLocker authorization. Returns the URL the member's browser must
 * be sent to. `fallbackRedirect` is used when no redirect_uri is configured.
 */
export async function startAuth(
  userId: string,
  opts: { fallbackRedirect: string; returnUrl?: string },
): Promise<{ authorize_url: string }> {
  const cfg = await config();
  if (!cfg) throw new Error('DigiLocker is not configured. Add the Client ID/Secret in API Hub → DigiLocker and activate it.');
  const redirectUri = cfg.redirectUri || opts.fallbackRedirect;
  const state = b64url(crypto.randomBytes(24));
  const codeVerifier = b64url(crypto.randomBytes(48)); // 64 chars, PKCE-compliant
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());

  await query(
    `INSERT INTO digilocker_sessions (user_id, state, code_verifier, redirect_uri, return_url, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + interval '10 minutes')`,
    [userId, state, codeVerifier, redirectUri, opts.returnUrl ?? null],
  );
  // Opportunistic cleanup of expired sessions.
  await query('DELETE FROM digilocker_sessions WHERE expires_at < now()').catch(() => undefined);

  const url = `${cfg.baseUrl}/public/oauth2/1/authorize`
    + `?response_type=code`
    + `&client_id=${encodeURIComponent(cfg.clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`
    + `&code_challenge=${encodeURIComponent(codeChallenge)}`
    + `&code_challenge_method=S256`;
  return { authorize_url: url };
}

export interface DigiKyc {
  digilocker_id?: string;
  name?: string;
  dob?: string;
  gender?: string;
  eaadhaar?: boolean;
}

/** Decode a JWT payload (id_token) without verifying — used only as a fallback
 *  source for the same claims the token response already carries. */
function decodeJwtClaims(idToken?: string): Record<string, unknown> {
  if (!idToken || idToken.split('.').length !== 3) return {};
  try {
    const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Complete the OAuth callback: validate state, exchange the code, extract the
 * verified identity and record a verified KYC document. Returns the member id
 * and the data, plus where to send the browser next.
 */
export async function handleCallback(code: string, state: string): Promise<{ userId: string; data: DigiKyc; returnUrl?: string }> {
  const sess = (await query<{ user_id: string; code_verifier: string; redirect_uri: string; return_url: string | null }>(
    `SELECT user_id, code_verifier, redirect_uri, return_url FROM digilocker_sessions
      WHERE state = $1 AND expires_at > now()`,
    [state],
  )).rows[0];
  if (!sess) throw new Error('This DigiLocker session has expired. Please start again.');
  await query('DELETE FROM digilocker_sessions WHERE state = $1', [state]);

  const cfg = await config();
  if (!cfg) throw new Error('DigiLocker is no longer configured.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: sess.redirect_uri,
    code_verifier: sess.code_verifier,
  }).toString();

  let token: Record<string, unknown>;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/public/oauth2/1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      logger.warn({ status: res.status, body: text.slice(0, 300) }, 'DigiLocker token exchange failed');
      throw new Error('token_exchange_failed');
    }
    token = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'DigiLocker token exchange failed');
    throw new Error('Could not complete DigiLocker verification. Please try again.');
  } finally {
    clearTimeout(timer);
  }

  const claims = decodeJwtClaims(token.id_token as string | undefined);
  const pick = (k: string) => (token[k] ?? claims[k]) as string | undefined;
  const data: DigiKyc = {
    digilocker_id: pick('digilockerid') || pick('digilocker_id') || pick('sub'),
    name: pick('name'),
    dob: pick('dob') || pick('birthdate'),
    gender: pick('gender'),
    eaadhaar: String(pick('eaadhaar') ?? '').toUpperCase() === 'Y',
  };

  await recordVerified(sess.user_id, data);
  return { userId: sess.user_id, data, returnUrl: sess.return_url ?? undefined };
}

/** Record a DigiLocker-verified identity as a verified KYC document and lift
 *  the member's overall KYC status. */
async function recordVerified(userId: string, data: DigiKyc): Promise<void> {
  const docNum = data.digilocker_id ? 'DL:' + data.digilocker_id : 'DigiLocker';
  const remarks = `DigiLocker e-KYC${data.name ? ' · ' + data.name : ''}${data.dob ? ' · DOB ' + data.dob : ''}`;
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO kyc_documents (user_id, doc_type, doc_number, status, remarks, reviewed_at)
       VALUES ($1,'aadhaar',$2,'verified',$3, now())`,
      [userId, docNum, remarks],
    );
    const { rows } = await client.query<{ status: string; n: string }>(
      'SELECT status, COUNT(*) AS n FROM kyc_documents WHERE user_id = $1 GROUP BY status', [userId]);
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    const next = byStatus.rejected ? 'rejected' : byStatus.verified ? 'verified' : 'pending';
    await client.query('UPDATE users SET kyc_status = $1 WHERE id = $2', [next, userId]);
  });
}
