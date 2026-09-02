import { PoolClient } from 'pg';
import { query } from '../../../db';
import { credit } from '../wallet/wallet.service';
import { logger } from '../../config/logger';

/**
 * Referral program. Every member has a referral code; a new member can sign up
 * with someone's code, and the referrer earns a wallet bonus when that referred
 * member completes their first successful transaction. Admin tunes the bonus
 * (site setting `referral_bonus`, rupees) and can switch it off.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

export function generateReferralCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

async function settingOn(key: string, def: boolean): Promise<boolean> {
  const { rows } = await query<{ value: string | null }>('SELECT value FROM site_settings WHERE key = $1', [key]);
  const v = rows[0]?.value;
  return v == null ? def : v === 'true';
}
async function referralBonusPaise(): Promise<number> {
  const { rows } = await query<{ value: string | null }>("SELECT value FROM site_settings WHERE key = 'referral_bonus'");
  const rupees = Number(rows[0]?.value);
  return Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : 0;
}

/** Resolve an active user's id from a referral code (case-insensitive). */
export async function resolveReferrer(code: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM users WHERE upper(referral_code) = upper($1) AND status = 'active' LIMIT 1",
    [code.trim()],
  );
  return rows[0]?.id ?? null;
}

/** Link a newly-created member to their referrer and open a pending referral. */
export async function linkReferral(client: PoolClient, newUserId: string, referrerId: string): Promise<void> {
  if (referrerId === newUserId) return;
  await client.query('UPDATE users SET referred_by = $1 WHERE id = $2 AND referred_by IS NULL', [referrerId, newUserId]);
  await client.query(
    'INSERT INTO referrals (referrer_id, referred_id, status) VALUES ($1,$2,$3) ON CONFLICT (referred_id) DO NOTHING',
    [referrerId, newUserId, 'pending'],
  );
}

/**
 * When a referred member completes a successful transaction, reward the
 * referrer once. Runs inside the settle transaction (best-effort — never throws,
 * so a reward hiccup can't fail a settlement). Returns the referrer + bonus so
 * the caller can notify, or null when nothing was rewarded.
 */
export async function rewardReferralOnFirstSuccess(
  client: PoolClient,
  referredUserId: string,
): Promise<{ referrerId: string; bonusPaise: number } | null> {
  try {
    if (!(await settingOn('referral_enabled', true))) return null;
    const { rows } = await client.query<{ id: string; referrer_id: string }>(
      "SELECT id, referrer_id FROM referrals WHERE referred_id = $1 AND status = 'pending' FOR UPDATE",
      [referredUserId],
    );
    const ref = rows[0];
    if (!ref) return null;
    const bonus = await referralBonusPaise();
    if (bonus <= 0) return null;
    await credit(client, {
      userId: ref.referrer_id,
      amountPaise: bonus,
      source: 'adjustment',
      referenceId: ref.id,
      description: 'Referral bonus',
    });
    await client.query('UPDATE referrals SET status = $2, bonus_paise = $3, rewarded_at = now() WHERE id = $1', [
      ref.id, 'rewarded', bonus,
    ]);
    return { referrerId: ref.referrer_id, bonusPaise: bonus };
  } catch (err) {
    logger.warn({ err: (err as Error).message, referredUserId }, 'rewardReferralOnFirstSuccess failed');
    return null;
  }
}

/** A member's referral code + stats + list of who they referred. */
export async function myReferral(userId: string) {
  const me = await query<{ referral_code: string }>('SELECT referral_code FROM users WHERE id = $1', [userId]);
  const list = await query<{ full_name: string; status: string; bonus_paise: string; created_at: string }>(
    `SELECT u.full_name, r.status, r.bonus_paise, r.created_at
       FROM referrals r JOIN users u ON u.id = r.referred_id
      WHERE r.referrer_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [userId],
  );
  const totals = await query<{ n: string; rewarded: string; earned: string }>(
    `SELECT COUNT(*) AS n,
            COUNT(*) FILTER (WHERE status = 'rewarded') AS rewarded,
            COALESCE(SUM(bonus_paise),0) AS earned
       FROM referrals WHERE referrer_id = $1`,
    [userId],
  );
  const bonus = await referralBonusPaise();
  return {
    code: me.rows[0]?.referral_code ?? null,
    bonus_paise: bonus,
    total: Number(totals.rows[0].n),
    rewarded: Number(totals.rows[0].rewarded),
    earned_paise: Number(totals.rows[0].earned),
    items: list.rows.map((r) => ({ ...r, bonus_paise: Number(r.bonus_paise) })),
  };
}
