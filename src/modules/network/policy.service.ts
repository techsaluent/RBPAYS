import { query } from '../../../db';
import { ApiError } from '../../utils/ApiError';

/**
 * Per-member transaction policy: amount limits (KYC vs non-KYC) and payout
 * gates (require-KYC / require-OTP). Absent row = no extra limits.
 */
export interface MemberPolicy {
  min_txn_paise: number;
  max_txn_paise: number;
  min_txn_nonkyc_paise: number;
  max_txn_nonkyc_paise: number;
  payout_require_kyc: boolean;
  payout_require_otp: boolean;
}

const DEFAULT: MemberPolicy = {
  min_txn_paise: 0, max_txn_paise: 0, min_txn_nonkyc_paise: 0, max_txn_nonkyc_paise: 0,
  payout_require_kyc: false, payout_require_otp: false,
};

export async function getMemberPolicy(userId: string): Promise<MemberPolicy> {
  const { rows } = await query<MemberPolicy>(
    `SELECT min_txn_paise, max_txn_paise, min_txn_nonkyc_paise, max_txn_nonkyc_paise,
            payout_require_kyc, payout_require_otp
       FROM member_txn_policy WHERE user_id = $1`,
    [userId],
  );
  if (!rows[0]) return { ...DEFAULT };
  return {
    min_txn_paise: Number(rows[0].min_txn_paise),
    max_txn_paise: Number(rows[0].max_txn_paise),
    min_txn_nonkyc_paise: Number(rows[0].min_txn_nonkyc_paise),
    max_txn_nonkyc_paise: Number(rows[0].max_txn_nonkyc_paise),
    payout_require_kyc: rows[0].payout_require_kyc,
    payout_require_otp: rows[0].payout_require_otp,
  };
}

const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`;

/**
 * Enforce the member's per-transaction min/max (the KYC or non-KYC band
 * depending on their verification). Throws 422 when out of band. No-op when
 * no limits are configured.
 */
export async function enforceTxnLimits(userId: string, amountPaise: number): Promise<void> {
  const { rows } = await query<{ kyc_status: string; min_txn_paise: string | null; max_txn_paise: string | null; min_txn_nonkyc_paise: string | null; max_txn_nonkyc_paise: string | null }>(
    `SELECT u.kyc_status, p.min_txn_paise, p.max_txn_paise, p.min_txn_nonkyc_paise, p.max_txn_nonkyc_paise
       FROM users u LEFT JOIN member_txn_policy p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r || r.min_txn_paise == null) return; // no policy row
  const verified = r.kyc_status === 'verified';
  const min = Number(verified ? r.min_txn_paise : r.min_txn_nonkyc_paise) || 0;
  const max = Number(verified ? r.max_txn_paise : r.max_txn_nonkyc_paise) || 0;
  if (min > 0 && amountPaise < min) {
    throw ApiError.unprocessable(`Minimum ${inr(min)} per transaction${verified ? '' : ' (non-KYC limit)'}.`);
  }
  if (max > 0 && amountPaise > max) {
    throw ApiError.unprocessable(`Maximum ${inr(max)} per transaction${verified ? '' : ' — complete KYC for higher limits'}.`);
  }
}
