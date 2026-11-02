import { withTransaction, query } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { createMember } from '../members/members.service';
import { credit } from '../wallet/wallet.service';
import { postJournal } from '../_shared/ledger';

/**
 * One-click "ready-to-test" demo retailer. Creates (idempotently) a retailer
 * under the super admin with KYC verified and a funded wallet, so the admin can
 * immediately run test transactions. Uses the same email/phone as the seed-demo
 * script, so the two never duplicate. Never re-funds an existing wallet.
 */
const DEMO = {
  email: 'demo.retailer@tutipays.local',
  phone: '9000000003',
  password: process.env.DEMO_PASSWORD || 'Demo@12345',
  fundRupees: 50000,
};

export interface DemoRetailerResult {
  email: string;
  phone: string;
  password: string;
  created: boolean;
  kyc_status: string;
  wallet_rupees: number;
}

export async function ensureDemoRetailer(): Promise<DemoRetailerResult> {
  const admin = (await query<{ id: string }>(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1",
  )).rows[0];
  if (!admin) throw ApiError.unprocessable('No admin account found.');

  const existing = (await query<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)', [DEMO.email],
  )).rows[0];

  let userId: string;
  let created = false;
  if (existing) {
    userId = existing.id;
  } else {
    const member = await createMember({
      parentId: admin.id,
      parentRole: 'admin',
      full_name: 'DEMO Retailer',
      email: DEMO.email,
      phone: DEMO.phone,
      password: DEMO.password,
      role: 'retailer',
    });
    userId = member.id;
    created = true;
    // Fund the wallet cleanly through the double-entry ledger (only on first
    // creation — never re-fund an existing demo wallet).
    const amountPaise = DEMO.fundRupees * 100;
    await withTransaction(async (client) => {
      await credit(client, { userId, amountPaise, source: 'adjustment', description: 'DEMO retailer funding' });
      await postJournal(client, {
        source: 'demo_seed',
        narration: 'DEMO retailer funding',
        lines: [
          { account: 'treasury_in_transit', direction: 'debit', amountPaise },
          { account: 'member_wallet', direction: 'credit', amountPaise, walletUserId: userId },
        ],
      });
    });
  }

  // Mark KYC verified so the retailer can transact even with "require KYC" on.
  await query("UPDATE users SET kyc_status = 'verified' WHERE id = $1 AND kyc_status <> 'verified'", [userId]);

  const w = (await query<{ balance_paise: string }>(
    'SELECT balance_paise FROM wallets WHERE user_id = $1', [userId],
  )).rows[0];

  return {
    email: DEMO.email,
    phone: DEMO.phone,
    password: DEMO.password,
    created,
    kyc_status: 'verified',
    wallet_rupees: Number(w?.balance_paise || 0) / 100,
  };
}
