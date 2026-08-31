import { query } from '../../../db';
import { sendSms } from './notify.service';
import { logger } from '../../config/logger';

/**
 * Member alerts (SMS, best-effort). Each is admin-toggleable via site_settings
 * and never throws — a failed alert must not affect a transaction.
 */
async function settingOn(key: string): Promise<boolean> {
  const { rows } = await query<{ value: string | null }>('SELECT value FROM site_settings WHERE key = $1', [key]);
  return rows[0]?.value === 'true';
}
async function settingNum(key: string, def: number): Promise<number> {
  const { rows } = await query<{ value: string | null }>('SELECT value FROM site_settings WHERE key = $1', [key]);
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) ? n : def;
}
async function memberPhone(userId: string): Promise<string | null> {
  const { rows } = await query<{ phone: string }>('SELECT phone FROM users WHERE id = $1', [userId]);
  return rows[0]?.phone ?? null;
}
async function brandName(): Promise<string> {
  const { rows } = await query<{ value: string }>("SELECT value FROM site_settings WHERE key = 'brand_name'");
  return rows[0]?.value || 'TutiPays';
}
const rupees = (paise: number): string => '₹' + (paise / 100).toFixed(2);

/** SMS the member the outcome of a money transaction (success / failed). */
export async function notifyTxn(
  userId: string,
  opts: { service: string; status: string; amountPaise: number; reference: string },
): Promise<void> {
  try {
    if (opts.status !== 'success' && opts.status !== 'failed') return;
    if (!(await settingOn('notify_txn_sms'))) return;
    const phone = await memberPhone(userId);
    if (!phone) return;
    const brand = await brandName();
    const svc = opts.service.replace(/_/g, ' ');
    const text =
      opts.status === 'success'
        ? `${brand}: ${svc} of ${rupees(opts.amountPaise)} SUCCESS. Ref ${opts.reference}.`
        : `${brand}: ${svc} of ${rupees(opts.amountPaise)} FAILED and refunded. Ref ${opts.reference}.`;
    await sendSms(phone, text);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'notifyTxn failed');
  }
}

/** SMS the member once when a debit takes their balance below the threshold. */
export async function notifyLowBalance(userId: string, balanceBeforePaise: number, balanceAfterPaise: number): Promise<void> {
  try {
    if (!(await settingOn('notify_low_balance'))) return;
    const threshold = (await settingNum('low_balance_threshold', 500)) * 100;
    if (!(balanceBeforePaise >= threshold && balanceAfterPaise < threshold)) return; // only on crossing
    const phone = await memberPhone(userId);
    if (!phone) return;
    const brand = await brandName();
    await sendSms(phone, `${brand}: Low wallet balance ${rupees(balanceAfterPaise)}. Please top up to keep transacting.`);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'notifyLowBalance failed');
  }
}

/** SMS the member when their KYC status changes (verified / rejected). */
export async function notifyKyc(userId: string, status: string): Promise<void> {
  try {
    if (!(await settingOn('notify_kyc'))) return;
    const phone = await memberPhone(userId);
    if (!phone) return;
    const brand = await brandName();
    const msg =
      status === 'verified'
        ? 'Your KYC is VERIFIED. You can now transact fully.'
        : status === 'rejected'
          ? 'Your KYC was REJECTED. Please re-submit correct documents.'
          : `Your KYC status is now ${status}.`;
    await sendSms(phone, `${brand}: ${msg}`);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'notifyKyc failed');
  }
}
