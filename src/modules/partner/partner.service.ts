import crypto from 'crypto';
import { query } from '../../../db';
import { logger } from '../../config/logger';
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

  const { rows } = await query(
    `INSERT INTO partner_api_keys
       (user_id, label, key_prefix, key_hash, environment, scopes, allowed_ips, rate_limit_per_min, callback_url, callback_secret)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, label, key_prefix, environment, scopes, allowed_ips, rate_limit_per_min, callback_url, created_at`,
    [
      input.userId, input.label ?? null, keyPrefix, hashApiKey(rawKey), env, scopes,
      input.allowedIps ?? [], input.rateLimitPerMin ?? 120, input.callbackUrl ?? null, callbackSecret,
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
  const { rows } = await query(
    `UPDATE partner_api_keys SET
        label              = COALESCE($3, label),
        scopes             = COALESCE($4, scopes),
        allowed_ips        = COALESCE($5, allowed_ips),
        rate_limit_per_min = COALESCE($6, rate_limit_per_min),
        callback_url       = $7
      WHERE id = $1 AND user_id = $2
      RETURNING id, label, key_prefix, environment, scopes, allowed_ips, rate_limit_per_min, callback_url, created_at`,
    [
      keyId, userId, patch.label ?? null, scopes ?? null, patch.allowedIps ?? null,
      patch.rateLimitPerMin ?? null,
      patch.callbackUrl === undefined ? null : patch.callbackUrl,
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

/**
 * Deliver a signed settlement callback to every active key of `userId` that has
 * a callback URL. Best-effort: never throws. Idempotent per (key, reference,
 * event) via a unique index, so a re-settle or webhook replay won't double-post.
 * Body is signed HMAC-SHA256 with the key's callback_secret (hex), sent as
 * X-TutiPays-Signature; partners verify it to trust the payload.
 */
export async function deliverPartnerCallback(userId: string, reference: string): Promise<void> {
  try {
    const keyRes = await query<{ id: string; callback_url: string; callback_secret: string | null }>(
      `SELECT id, callback_url, callback_secret FROM partner_api_keys
        WHERE user_id = $1 AND revoked_at IS NULL AND callback_url IS NOT NULL AND callback_url <> ''`,
      [userId],
    );
    if (keyRes.rows.length === 0) return;

    const txnRes = await query<TxnForCallback>(
      `SELECT reference, service, status, amount_paise, net_paise, provider, status_message, created_at
         FROM transactions WHERE reference = $1`,
      [reference],
    );
    const txn = txnRes.rows[0];
    if (!txn) return;

    const event = `transaction.${txn.status}`;
    const payload = {
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
    };
    const body = JSON.stringify(payload);

    for (const k of keyRes.rows) {
      // Claim the (key, reference, event) slot; if it already exists we've
      // delivered (or are delivering) this event for this key — skip.
      const claim = await query<{ id: string }>(
        `INSERT INTO partner_webhook_deliveries (key_id, user_id, reference, event, url, request_body)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (key_id, reference, event) DO NOTHING
         RETURNING id`,
        [k.id, userId, reference, event, k.callback_url, body],
      );
      if (!claim.rows[0]) continue;
      const deliveryId = claim.rows[0].id;
      const signature = crypto.createHmac('sha256', k.callback_secret || '').update(body).digest('hex');

      let status = 0;
      let error: string | null = null;
      let delivered = false;
      let attempts = 0;
      // Up to 3 attempts with a short backoff; 2xx is success.
      for (attempts = 1; attempts <= 3; attempts++) {
        try {
          const r = await postOnce(k.callback_url, body, signature);
          status = r.status;
          if (r.status >= 200 && r.status < 300) { delivered = true; break; }
          error = `HTTP ${r.status}`;
        } catch (e) {
          error = (e as Error).message;
        }
        if (attempts < 3) await new Promise((res) => setTimeout(res, 500 * attempts));
      }

      const attemptsMade = Math.min(attempts, 3); // loop ends at 4 when all fail
      await query(
        `UPDATE partner_webhook_deliveries
            SET response_status = $2, attempts = $3, delivered = $4, error = $5, updated_at = now()
          WHERE id = $1`,
        [deliveryId, status || null, attemptsMade, delivered, delivered ? null : error],
      );
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message, userId, reference }, 'partner callback delivery failed');
  }
}
