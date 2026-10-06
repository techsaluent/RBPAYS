import crypto from 'crypto';
import { query } from '../../../db';
import { logger } from '../../config/logger';
import { env as appEnv } from '../../config/env';
import { hashApiKey } from '../../middleware/auth';
import { ApiError } from '../../utils/ApiError';
import { bigintToNumber, paiseToRupees } from '../../utils/money';

// Service codes a partner key may be scoped for (or '*' for all).
export const PARTNER_SERVICES = [
  'recharge', 'bbps', 'dmt', 'payout', 'aeps', 'cms', 'upi', 'matm',
  'aadhaar_pay', 'pan_card', 'card_swipe', 'wallet_transfer', 'travel', 'insurance',
] as const;

export interface NewKeyInput {
  userId: string;
  label?: string;
  environment?: 'live' | 'test';
  scopes?: string[];
  allowedIps?: string[];
  rateLimitPerMin?: number;
  callbackUrl?: string | null;
}

function randHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Validate a partner callback URL before we store (and later POST to) it.
 * Guards against SSRF: webhooks are server-initiated requests to a
 * caller-supplied URL, so a hostile reseller could otherwise aim them at
 * internal services or the cloud metadata endpoint. We require https in
 * production and reject loopback / private / link-local / reserved hosts and
 * known-internal hostnames. Returns the normalized URL, or throws 400.
 */
export function assertSafeCallbackUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw ApiError.badRequest('Callback URL is not a valid URL');
  }
  const isProd = appEnv.isProd;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !isProd)) {
    throw ApiError.badRequest('Callback URL must use https://');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // unwrap IPv6 brackets

  // Block obvious internal hostnames.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw ApiError.badRequest('Callback URL host is not allowed');
  }

  // Block private / loopback / link-local / reserved IP literals.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const blocked =
      a === 0 || a === 10 || a === 127 ||                 // this-net, private, loopback
      (a === 169 && b === 254) ||                         // link-local (incl. 169.254.169.254 metadata)
      (a === 172 && b >= 16 && b <= 31) ||                // private
      (a === 192 && b === 168) ||                         // private
      (a === 100 && b >= 64 && b <= 127) ||               // CGNAT
      a >= 224;                                           // multicast / reserved
    if (blocked) throw ApiError.badRequest('Callback URL points to a private or reserved IP');
  }
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    throw ApiError.badRequest('Callback URL points to a private or reserved IPv6 address');
  }
  return u.toString();
}

/** Normalize an optional callback URL: '' / null clears it, else validate. */
function normalizeCallback(url: string | null | undefined): string | null {
  if (url === undefined || url === null) return null;
  const t = String(url).trim();
  if (t === '') return null;
  return assertSafeCallbackUrl(t);
}

/** Normalize/validate a requested scope list against the known services. */
function cleanScopes(scopes?: string[]): string[] {
  if (!scopes || scopes.length === 0) return ['*'];
  if (scopes.includes('*')) return ['*'];
  const allowed = new Set<string>(PARTNER_SERVICES as readonly string[]);
  const out = scopes.filter((s) => allowed.has(s));
  if (out.length === 0) throw ApiError.badRequest('No valid service scopes given');
  return Array.from(new Set(out));
}

/**
 * Create a partner API key for a member. Returns the FULL raw key and callback
 * signing secret ONCE — only their hashes/plaintext-secret are persisted and the
 * raw key is never recoverable afterwards.
 */
export async function createKey(input: NewKeyInput) {
  const env = input.environment === 'test' ? 'test' : 'live';
  const rawKey = `pk_${env}_${randHex(24)}`;
  const keyPrefix = rawKey.slice(0, 16); // e.g. pk_live_1a2b3c4d
  const callbackSecret = `whsec_${randHex(24)}`;
  const scopes = cleanScopes(input.scopes);
  const callbackUrl = normalizeCallback(input.callbackUrl);

  const { rows } = await query(
    `INSERT INTO partner_api_keys
       (user_id, label, key_prefix, key_hash, environment, scopes, allowed_ips, rate_limit_per_min, callback_url, callback_secret)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, label, key_prefix, environment, scopes, allowed_ips, rate_limit_per_min, callback_url, created_at`,
    [
      input.userId, input.label ?? null, keyPrefix, hashApiKey(rawKey), env, scopes,
      input.allowedIps ?? [], input.rateLimitPerMin ?? 120, callbackUrl, callbackSecret,
    ],
  );
  // Raw key + signing secret are surfaced ONCE to the caller here.
  return { ...rows[0], api_key: rawKey, callback_secret: callbackSecret };
}

/** List a member's keys (never returns the hash or raw key). */
export async function listKeys(userId: string) {
  const { rows } = await query(
    `SELECT id, label, key_prefix, environment, scopes, allowed_ips, rate_limit_per_min,
            callback_url, last_used_at, revoked_at, created_at,
            (revoked_at IS NULL) AS active
       FROM partner_api_keys
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/** Update mutable settings on a key the member owns. */
export async function updateKey(
  userId: string, keyId: string,
  patch: { label?: string; scopes?: string[]; allowedIps?: string[]; rateLimitPerMin?: number; callbackUrl?: string | null },
) {
  const scopes = patch.scopes !== undefined ? cleanScopes(patch.scopes) : undefined;
  // undefined => leave callback unchanged; null/'' => clear; else validate.
  const touchCallback = patch.callbackUrl !== undefined;
  const callbackUrl = touchCallback ? normalizeCallback(patch.callbackUrl) : null;
  const { rows } = await query(
    `UPDATE partner_api_keys SET
        label              = COALESCE($3, label),
        scopes             = COALESCE($4, scopes),
        allowed_ips        = COALESCE($5, allowed_ips),
        rate_limit_per_min = COALESCE($6, rate_limit_per_min),
        callback_url       = CASE WHEN $7 THEN $8 ELSE callback_url END
      WHERE id = $1 AND user_id = $2
      RETURNING id, label, key_prefix, environment, scopes, allowed_ips, rate_limit_per_min, callback_url, created_at`,
    [
      keyId, userId, patch.label ?? null, scopes ?? null, patch.allowedIps ?? null,
      patch.rateLimitPerMin ?? null, touchCallback, callbackUrl,
    ],
  );
  if (!rows[0]) throw ApiError.notFound('API key not found');
  return rows[0];
}

/** Reveal the callback signing secret for one of the member's keys. */
export async function getCallbackSecret(userId: string, keyId: string) {
  const { rows } = await query<{ callback_secret: string | null }>(
    'SELECT callback_secret FROM partner_api_keys WHERE id = $1 AND user_id = $2',
    [keyId, userId],
  );
  if (!rows[0]) throw ApiError.notFound('API key not found');
  return rows[0].callback_secret;
}

/** Revoke (permanently disable) a key the member owns. */
export async function revokeKey(userId: string, keyId: string) {
  const { rows } = await query(
    `UPDATE partner_api_keys SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [keyId, userId],
  );
  if (!rows[0]) throw ApiError.notFound('Active API key not found');
  return true;
}

/** Recent outbound-callback deliveries for a member's keys. */
export async function listDeliveries(userId: string, limit = 30) {
  const { rows } = await query(
    `SELECT d.id, d.reference, d.event, d.url, d.response_status, d.attempts, d.delivered, d.error, d.created_at,
            k.key_prefix
       FROM partner_webhook_deliveries d
       JOIN partner_api_keys k ON k.id = d.key_id
      WHERE d.user_id = $1
      ORDER BY d.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

// ---- Outbound callback delivery -----------------------------------------

interface TxnForCallback {
  reference: string; service: string; status: string;
  amount_paise: string; net_paise: string; provider: string | null;
  status_message: string | null; created_at: string;
}

async function postOnce(url: string, body: string, signature: string): Promise<{ status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TutiPays-Signature': signature,
        'X-TutiPays-Event': JSON.parse(body).event,
        'User-Agent': 'TutiPays-Webhook/1',
      },
      body,
      signal: controller.signal,
    });
    return { status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/** Run the signed POST with up to 3 attempts; returns the delivery outcome. */
async function attemptDelivery(url: string, secret: string, body: string) {
  const signature = crypto.createHmac('sha256', secret || '').update(body).digest('hex');
  let status = 0;
  let error: string | null = null;
  let delivered = false;
  let attempts = 0;
  for (attempts = 1; attempts <= 3; attempts++) {
    try {
      const r = await postOnce(url, body, signature);
      status = r.status;
      if (r.status >= 200 && r.status < 300) { delivered = true; break; }
      error = `HTTP ${r.status}`;
    } catch (e) {
      error = (e as Error).message;
    }
    if (attempts < 3) await new Promise((res) => setTimeout(res, 500 * attempts));
  }
  return { status, delivered, error, attempts: Math.min(attempts, 3) };
}

/** The account-level default callback (fallback for keys without their own). */
async function accountDefault(userId: string): Promise<{ url: string; secret: string } | null> {
  const { rows } = await query<{ callback_url: string | null; callback_secret: string | null }>(
    'SELECT callback_url, callback_secret FROM partner_callback_defaults WHERE user_id = $1',
    [userId],
  );
  const d = rows[0];
  if (!d || !d.callback_url) return null;
  return { url: d.callback_url, secret: d.callback_secret || '' };
}

/**
 * Deliver a signed settlement callback for a member. Each active key delivers to
 * its own callback URL, or — when it has none — to the member's account-level
 * default. Best-effort: never throws. Idempotent per (key, reference, event),
 * and de-duplicated by URL so two keys sharing an endpoint post once. Body is
 * signed HMAC-SHA256 with the effective secret, sent as X-TutiPays-Signature.
 */
export async function deliverPartnerCallback(userId: string, reference: string): Promise<void> {
  try {
    const keyRes = await query<{ id: string; callback_url: string | null; callback_secret: string | null }>(
      'SELECT id, callback_url, callback_secret FROM partner_api_keys WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    if (keyRes.rows.length === 0) return;
    const fallback = await accountDefault(userId);

    // Resolve each key's effective endpoint; drop keys with none; one per URL.
    const seen = new Set<string>();
    const targets: Array<{ keyId: string; url: string; secret: string }> = [];
    for (const k of keyRes.rows) {
      const url = k.callback_url || fallback?.url || null;
      const secret = k.callback_url ? (k.callback_secret || '') : (fallback?.secret || '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      targets.push({ keyId: k.id, url, secret });
    }
    if (targets.length === 0) return;

    const txnRes = await query<TxnForCallback>(
      `SELECT reference, service, status, amount_paise, net_paise, provider, status_message, created_at
         FROM transactions WHERE reference = $1`,
      [reference],
    );
    const txn = txnRes.rows[0];
    if (!txn) return;

    const event = `transaction.${txn.status}`;
    const body = JSON.stringify({
      event,
      created_at: new Date().toISOString(),
      data: {
        reference: txn.reference,
        service: txn.service,
        status: txn.status,
        amount: paiseToRupees(txn.amount_paise),
        amount_paise: bigintToNumber(txn.amount_paise),
        net_paise: bigintToNumber(txn.net_paise),
        provider: txn.provider,
        message: txn.status_message,
        transacted_at: txn.created_at,
      },
    });

    for (const t of targets) {
      // Claim the (key, reference, event) slot; skip if already delivered.
      const claim = await query<{ id: string }>(
        `INSERT INTO partner_webhook_deliveries (key_id, user_id, reference, event, url, request_body)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (key_id, reference, event) DO NOTHING
         RETURNING id`,
        [t.keyId, userId, reference, event, t.url, body],
      );
      if (!claim.rows[0]) continue;
      const deliveryId = claim.rows[0].id;
      const r = await attemptDelivery(t.url, t.secret, body);
      await query(
        `UPDATE partner_webhook_deliveries
            SET response_status = $2, attempts = $3, delivered = $4, error = $5, updated_at = now()
          WHERE id = $1`,
        [deliveryId, r.status || null, r.attempts, r.delivered, r.delivered ? null : r.error],
      );
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message, userId, reference }, 'partner callback delivery failed');
  }
}

/**
 * Send a signed `test.ping` to a key's effective callback URL so the member can
 * confirm their endpoint before going live. Logged like any other delivery.
 */
export async function sendTestCallback(userId: string, keyId: string) {
  const { rows } = await query<{ callback_url: string | null; callback_secret: string | null }>(
    'SELECT callback_url, callback_secret FROM partner_api_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [keyId, userId],
  );
  if (!rows[0]) throw ApiError.notFound('Active API key not found');
  const fallback = await accountDefault(userId);
  const url = rows[0].callback_url || fallback?.url || null;
  const secret = rows[0].callback_url ? (rows[0].callback_secret || '') : (fallback?.secret || '');
  if (!url) throw ApiError.badRequest('No callback URL set on this key or account default');

  const reference = `test_${Date.now().toString(36)}${randHex(3)}`;
  const body = JSON.stringify({
    event: 'test.ping',
    created_at: new Date().toISOString(),
    data: { message: 'TutiPays webhook test', key_id: keyId },
  });
  const claim = await query<{ id: string }>(
    `INSERT INTO partner_webhook_deliveries (key_id, user_id, reference, event, url, request_body)
     VALUES ($1,$2,$3,'test.ping',$4,$5) RETURNING id`,
    [keyId, userId, reference, url, body],
  );
  const r = await attemptDelivery(url, secret, body);
  await query(
    `UPDATE partner_webhook_deliveries
        SET response_status = $2, attempts = $3, delivered = $4, error = $5, updated_at = now()
      WHERE id = $1`,
    [claim.rows[0].id, r.status || null, r.attempts, r.delivered, r.delivered ? null : r.error],
  );
  return { delivered: r.delivered, response_status: r.status, attempts: r.attempts, url, error: r.delivered ? null : r.error };
}

// ---- Account-level default callback -------------------------------------

/** Read the member's account-level default callback (never the secret). */
export async function getCallbackDefaultInfo(userId: string) {
  const { rows } = await query<{ callback_url: string | null; updated_at: string | null }>(
    'SELECT callback_url, updated_at FROM partner_callback_defaults WHERE user_id = $1',
    [userId],
  );
  const d = rows[0];
  return { callback_url: d?.callback_url ?? null, has_secret: !!(d && d.callback_url), updated_at: d?.updated_at ?? null };
}

/** Reveal the account-default signing secret. */
export async function getCallbackDefaultSecret(userId: string) {
  const { rows } = await query<{ callback_secret: string | null }>(
    'SELECT callback_secret FROM partner_callback_defaults WHERE user_id = $1',
    [userId],
  );
  return rows[0]?.callback_secret ?? null;
}

/**
 * Set (or clear) the account-level default callback URL. Setting a new URL
 * generates a fresh signing secret, returned ONCE. Clearing removes the row.
 */
export async function setCallbackDefault(userId: string, url: string | null | undefined) {
  const normalized = normalizeCallback(url);
  if (!normalized) {
    await query('DELETE FROM partner_callback_defaults WHERE user_id = $1', [userId]);
    return { callback_url: null as string | null };
  }
  const secret = `whsec_${randHex(24)}`;
  await query(
    `INSERT INTO partner_callback_defaults (user_id, callback_url, callback_secret, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (user_id) DO UPDATE SET callback_url = $2, callback_secret = $3, updated_at = now()`,
    [userId, normalized, secret],
  );
  return { callback_url: normalized, callback_secret: secret };
}
