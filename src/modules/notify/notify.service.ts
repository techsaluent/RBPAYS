import { query } from '../../../db';
import { httpJson } from '../../providers/http';
import { logger } from '../../config/logger';

/**
 * Outbound messaging through the super-admin's configured integrations.
 *
 * Credentials live in `platform_integrations` (managed from the admin
 * Integrations console). SMS goes through the active `sms` row, falling back
 * to the `otp` row. Response shapes vary by gateway (MSG91, Textlocal, Gupshup,
 * …) so the POST is intentionally tolerant — a non-throwing call is treated as
 * delivered. Adjust the payload/path in `sendSms` to match your gateway's docs.
 */
interface MessagingConfig {
  key: string;
  provider: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  senderId: string | null;
}

async function activeMessagingConfig(): Promise<MessagingConfig | null> {
  const { rows } = await query<{
    key: string;
    provider: string | null;
    base_url: string | null;
    api_key: string | null;
    api_secret: string | null;
    sender_id: string | null;
  }>(
    `SELECT key, provider, base_url, api_key, api_secret, sender_id
       FROM platform_integrations
      WHERE key IN ('sms','otp') AND is_active = true
      ORDER BY CASE key WHEN 'sms' THEN 0 ELSE 1 END
      LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    key: r.key,
    provider: r.provider,
    baseUrl: r.base_url,
    apiKey: r.api_key,
    apiSecret: r.api_secret,
    senderId: r.sender_id,
  };
}

/**
 * Send an SMS best-effort. Returns true when a gateway is configured and the
 * request did not error, false when no gateway is configured (caller then
 * relies on the dev-code fallback / logs). Never throws.
 */
export async function sendSms(phone: string, text: string): Promise<boolean> {
  const cfg = await activeMessagingConfig();
  if (!cfg || !cfg.baseUrl) {
    logger.warn({ phone }, 'no active SMS/OTP integration configured — message not sent');
    return false;
  }
  try {
    await httpJson(cfg.baseUrl, {
      method: 'POST',
      headers: {
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}`, 'X-Api-Key': cfg.apiKey } : {}),
        ...(cfg.apiSecret ? { 'X-Api-Secret': cfg.apiSecret } : {}),
      },
      body: { sender: cfg.senderId, to: phone, message: text },
    });
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message, provider: cfg.provider }, 'SMS send failed');
    return false;
  }
}
