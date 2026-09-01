import { query } from '../../../db';
import { dispatch, Channel } from './notify.service';
import { logger } from '../../config/logger';

/**
 * Member alerts, best-effort across the admin-enabled channels (SMS / WhatsApp
 * / Email). Each event is admin-toggleable via site_settings and never throws —
 * a failed alert must not affect a transaction.
 *
 * Which EVENTS fire: notify_txn_sms, notify_low_balance, notify_kyc.
 * Which CHANNELS carry them: notify_sms (default on), notify_whatsapp, notify_email.
 */
async function settingOn(key: string, def = false): Promise<boolean> {
  const { rows } = await query<{ value: string | null }>('SELECT value FROM site_settings WHERE key = $1', [key]);
  const v = rows[0]?.value;
  return v == null ? def : v === 'true';
}
async function settingNum(key: string, def: number): Promise<number> {
  const { rows } = await query<{ value: string | null }>('SELECT value FROM site_settings WHERE key = $1', [key]);
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) ? n : def;
}
async function memberContact(userId: string): Promise<{ phone: string | null; email: string | null }> {
  const { rows } = await query<{ phone: string | null; email: string | null }>('SELECT phone, email FROM users WHERE id = $1', [userId]);
  return { phone: rows[0]?.phone ?? null, email: rows[0]?.email ?? null };
}
async function brandName(): Promise<string> {
  const { rows } = await query<{ value: string }>("SELECT value FROM site_settings WHERE key = 'brand_name'");
  return rows[0]?.value || 'TutiPays';
}
/** The channels the admin has switched on (SMS defaults on). */
async function enabledChannels(): Promise<Channel[]> {
  const [sms, wa, email] = await Promise.all([
    settingOn('notify_sms', true),
    settingOn('notify_whatsapp', false),
    settingOn('notify_email', false),
  ]);
  const ch: Channel[] = [];
  if (sms) ch.push('sms');
  if (wa) ch.push('whatsapp');
  if (email) ch.push('email');
  return ch;
}
const rupees = (paise: number): string => '₹' + (paise / 100).toFixed(2);

/** Send one member alert across every enabled channel. */
async function alert(userId: string, subject: string, text: string): Promise<void> {
  const channels = await enabledChannels();
  if (!channels.length) return;
  const { phone, email } = await memberContact(userId);
  if (!phone && !email) return;
  await dispatch({ phone, email, subject, text, channels });
}

/** Notify the member the outcome of a money transaction (success / failed). */
export async function notifyTxn(
  userId: string,
  opts: { service: string; status: string; amountPaise: number; reference: string },
): Promise<void> {
  try {
    if (opts.status !== 'success' && opts.status !== 'failed') return;
    if (!(await settingOn('notify_txn_sms'))) return;
    const brand = await brandName();
    const svc = opts.service.replace(/_/g, ' ');
    const text =
      opts.status === 'success'
        ? `${brand}: ${svc} of ${rupees(opts.amountPaise)} SUCCESS. Ref ${opts.reference}.`
        : `${brand}: ${svc} of ${rupees(opts.amountPaise)} FAILED and refunded. Ref ${opts.reference}.`;
    await alert(userId, `${brand} transaction ${opts.status}`, text);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'notifyTxn failed');
  }
}

/** Notify the member once when a debit takes their balance below the threshold. */
export async function notifyLowBalance(userId: string, balanceBeforePaise: number, balanceAfterPaise: number): Promise<void> {
  try {
    if (!(await settingOn('notify_low_balance'))) return;
    const threshold = (await settingNum('low_balance_threshold', 500)) * 100;
    if (!(balanceBeforePaise >= threshold && balanceAfterPaise < threshold)) return; // only on crossing
    const brand = await brandName();
    await alert(userId, `${brand} low balance`, `${brand}: Low wallet balance ${rupees(balanceAfterPaise)}. Please top up to keep transacting.`);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'notifyLowBalance failed');
  }
}

/** Notify the member when their KYC status changes (verified / rejected). */
export async function notifyKyc(userId: string, status: string): Promise<void> {
  try {
    if (!(await settingOn('notify_kyc'))) return;
    const brand = await brandName();
    const msg =
      status === 'verified'
        ? 'Your KYC is VERIFIED. You can now transact fully.'
        : status === 'rejected'
          ? 'Your KYC was REJECTED. Please re-submit correct documents.'
          : `Your KYC status is now ${status}.`;
    await alert(userId, `${brand} KYC ${status}`, `${brand}: ${msg}`);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'notifyKyc failed');
  }
}
