import { query } from '../../../db';
import nodemailer from 'nodemailer';
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
 * Email best-effort via the active `email` integration. Two transports:
 *   - Generic SMTP (provider = 'smtp', or extra.transport = 'smtp'): a standard
 *     mail server via nodemailer. Mapping — host = extra.smtp_host || base_url,
 *     port = extra.smtp_port (587), secure = extra.smtp_secure (true for 465),
 *     user = api_key, pass = api_secret, From = sender_id.
 *   - JSON email API (default): SendGrid / Mailgun / Postmark / SMTP-to-HTTP
 *     bridge — POSTs to base_url.
 * `sender_id` is the From address. Sends both text and a minimal html part.
 */
function htmlPart(text: string): string {
  return `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`;
}

async function sendEmailSmtp(cfg: MessagingConfig, to: string, subject: string, text: string): Promise<boolean> {
  const host = String((cfg.extra?.smtp_host as string) || cfg.baseUrl || '').trim();
  if (!host) {
    logger.warn('SMTP email selected but no host (set base_url or extra.smtp_host)');
    return false;
  }
  const port = Number(cfg.extra?.smtp_port) || 587;
  const secure = cfg.extra?.smtp_secure === true || cfg.extra?.smtp_secure === 'true' || port === 465;
  const from = cfg.senderId || cfg.apiKey || 'no-reply@localhost';
  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: cfg.apiKey ? { user: cfg.apiKey, pass: cfg.apiSecret || '' } : undefined,
    });
    await transporter.sendMail({ from, to, subject, text, html: htmlPart(text) });
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message, host }, 'SMTP email send failed');
    return false;
  }
}

export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const cfg = await integrationConfig(['email']);
  if (!cfg || !to) return false;
  const isSmtp = (cfg.provider || '').toLowerCase() === 'smtp' || String(cfg.extra?.transport || '').toLowerCase() === 'smtp';
  if (isSmtp) return sendEmailSmtp(cfg, to, subject, text);
  if (!cfg.baseUrl) return false;
  try {
    await httpJson(cfg.baseUrl, {
      method: 'POST',
      headers: authHeaders(cfg),
      body: {
        from: cfg.senderId,
        to,
        subject,
        text,
        html: htmlPart(text),
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
/**
 * Record an in-app notification for a member's inbox. Best-effort — a logging
 * failure must never affect the caller (a transaction, KYC review, etc.).
 */
export async function addNotification(
  userId: string,
  type: 'txn' | 'kyc' | 'balance' | 'broadcast' | 'info',
  title: string,
  body?: string,
): Promise<void> {
  try {
    await query('INSERT INTO notifications (user_id, type, title, body) VALUES ($1,$2,$3,$4)', [
      userId, type, title, body ?? null,
    ]);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'addNotification failed');
  }
}

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
