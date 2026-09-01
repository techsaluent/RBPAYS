import { query } from '../../../db';
import { httpJson } from '../../providers/http';
import { logger } from '../../config/logger';

/**
 * Outbound messaging through the super-admin's configured integrations.
 *
 * Credentials live in `platform_integrations` (managed from the admin
 * Integrations console): the `sms` (fallback `otp`), `whatsapp` and `email`
 * rows. Response shapes vary by provider (MSG91, Gupshup, WATI, Meta Cloud,
 * SendGrid, Mailgun, SMTP-bridge, …) so each POST is intentionally tolerant —
 * a non-throwing call is treated as delivered. All senders are best-effort and
 * never throw, so a messaging outage can never affect a transaction.
 */
export type Channel = 'sms' | 'whatsapp' | 'email';

interface MessagingConfig {
  key: string;
  provider: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  senderId: string | null;
  extra: Record<string, unknown>;
}

/** First active integration among the given keys (priority = order given). */
async function integrationConfig(keys: string[]): Promise<MessagingConfig | null> {
  const order = keys.map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ');
  const { rows } = await query<{
    key: string; provider: string | null; base_url: string | null;
    api_key: string | null; api_secret: string | null; sender_id: string | null;
    extra: Record<string, unknown> | null;
  }>(
    `SELECT key, provider, base_url, api_key, api_secret, sender_id, extra
       FROM platform_integrations
      WHERE key = ANY($1) AND is_active = true
      ORDER BY CASE key ${order} ELSE 99 END
      LIMIT 1`,
    [keys],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    key: r.key, provider: r.provider, baseUrl: r.base_url,
    apiKey: r.api_key, apiSecret: r.api_secret, senderId: r.sender_id, extra: r.extra ?? {},
  };
}

function authHeaders(c: MessagingConfig): Record<string, string> {
  return {
    ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}`, 'X-Api-Key': c.apiKey } : {}),
    ...(c.apiSecret ? { 'X-Api-Secret': c.apiSecret } : {}),
  };
}

/** SMS best-effort via the active `sms` (fallback `otp`) integration. */
export async function sendSms(phone: string, text: string): Promise<boolean> {
  const cfg = await integrationConfig(['sms', 'otp']);
  if (!cfg?.baseUrl) {
    logger.warn({ phone }, 'no active SMS/OTP integration — message not sent');
    return false;
  }
  try {
    await httpJson(cfg.baseUrl, {
      method: 'POST',
      headers: authHeaders(cfg),
      body: { sender: cfg.senderId, to: phone, message: text, ...(cfg.extra || {}) },
    });
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message, provider: cfg.provider }, 'SMS send failed');
    return false;
  }
}

/**
 * WhatsApp best-effort via the active `whatsapp` integration. Works with the
 * common Business-API providers (Gupshup, WATI, Meta Cloud, Interakt, …). When
 * the provider requires an approved template, put its name/params in the
 * integration's Advanced config (extra) — it is merged into the payload.
 */
export async function sendWhatsApp(phone: string, text: string): Promise<boolean> {
  const cfg = await integrationConfig(['whatsapp']);
  if (!cfg?.baseUrl) return false;
  try {
    await httpJson(cfg.baseUrl, {
      method: 'POST',
      headers: authHeaders(cfg),
      body: { from: cfg.senderId, to: phone, type: 'text', message: text, text, ...(cfg.extra || {}) },
    });
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message, provider: cfg.provider }, 'WhatsApp send failed');
    return false;
  }
}

/**
 * Email best-effort via the active `email` integration (a JSON email API such
 * as SendGrid / Mailgun / Postmark, or an SMTP-to-HTTP bridge). `sender_id`
 * is the From address. Sends both text and a minimal html part.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const cfg = await integrationConfig(['email']);
  if (!cfg?.baseUrl || !to) return false;
  try {
    await httpJson(cfg.baseUrl, {
      method: 'POST',
      headers: authHeaders(cfg),
      body: {
        from: cfg.senderId,
        to,
        subject,
        text,
        html: `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
        ...(cfg.extra || {}),
      },
    });
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message, provider: cfg.provider }, 'Email send failed');
    return false;
  }
}

/**
 * Fan a message out to the requested channels best-effort. Returns which
 * channels reported success. Missing recipient / inactive integration for a
 * channel is silently skipped. Never throws.
 */
export async function dispatch(opts: {
  phone?: string | null;
  email?: string | null;
  text: string;
  subject?: string;
  channels: Channel[];
}): Promise<Record<Channel, boolean>> {
  const out: Record<Channel, boolean> = { sms: false, whatsapp: false, email: false };
  const jobs: Promise<void>[] = [];
  if (opts.channels.includes('sms') && opts.phone) jobs.push(sendSms(opts.phone, opts.text).then((ok) => { out.sms = ok; }));
  if (opts.channels.includes('whatsapp') && opts.phone) jobs.push(sendWhatsApp(opts.phone, opts.text).then((ok) => { out.whatsapp = ok; }));
  if (opts.channels.includes('email') && opts.email) jobs.push(sendEmail(opts.email, opts.subject || opts.text.slice(0, 60), opts.text).then((ok) => { out.email = ok; }));
  await Promise.allSettled(jobs);
  return out;
}
