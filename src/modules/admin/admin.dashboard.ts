import { query } from '../../../db';

const SERVICE_TABLES: Record<string, string> = {
  dmt: 'dmt_transactions',
  bbps: 'bbps_transactions',
  recharge: 'recharge_transactions',
  payout: 'payout_transactions',
  aeps: 'aeps_transactions',
  cms: 'cms_transactions',
  card_swipe: 'card_swipe_transactions',
  upi: 'upi_transactions',
  matm: 'matm_transactions',
  aadhaar_pay: 'aadhaar_pay_transactions',
  pan_card: 'pan_card_transactions',
  travel: 'travel_transactions',
  insurance: 'insurance_transactions',
};

/** Aggregate stats for the admin dashboard. */
export async function dashboardStats() {
  const usersByRole = await query<{ role: string; n: string }>(
    'SELECT role, COUNT(*) AS n FROM users GROUP BY role',
  );

  const walletFloat = await query<{ total: string }>(
    'SELECT COALESCE(SUM(balance_paise),0) AS total FROM wallets',
  );

  const pendingKyc = await query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM kyc_documents WHERE status = 'pending'",
  );

  const commissionPaid = await query<{ total: string }>(
    'SELECT COALESCE(SUM(amount_paise),0) AS total FROM commission_entries',
  );

  // Platform-wide transaction stats (IST day/month) from the unified ledger.
  const txn = await query<Record<string, string>>(
    `SELECT
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE status = 'success') AS success_count,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
        COALESCE(SUM(amount_paise) FILTER (WHERE status = 'success'), 0) AS success_amount,
        COUNT(*) FILTER (
          WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
        ) AS today_count,
        COALESCE(SUM(amount_paise) FILTER (
          WHERE status = 'success'
            AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
        ), 0) AS today_amount,
        COALESCE(SUM(amount_paise) FILTER (
          WHERE status = 'success'
            AND date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata')
                = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')
        ), 0) AS month_amount
      FROM transactions`,
  );
  const t = txn.rows[0];
  const tn = (k: string) => Number(t[k] ?? 0);
  const totalTxn = tn('total_count');
  const successTxn = tn('success_count');

  // Per-service volume: successful count + amount.
  const volumes: Record<string, { success_count: number; success_amount_paise: number; total_count: number }> = {};
  for (const [code, table] of Object.entries(SERVICE_TABLES)) {
    const { rows } = await query<{ success_count: string; success_amount: string; total_count: string }>(
      `SELECT
          COUNT(*) FILTER (WHERE status = 'success') AS success_count,
          COALESCE(SUM(amount_paise) FILTER (WHERE status = 'success'),0) AS success_amount,
          COUNT(*) AS total_count
        FROM ${table}`,
    );
    volumes[code] = {
      success_count: Number(rows[0].success_count),
      success_amount_paise: Number(rows[0].success_amount),
      total_count: Number(rows[0].total_count),
    };
  }

  const pgVolume = await query<{ success_amount: string; success_count: string }>(
    `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE status = 'success'),0) AS success_amount,
            COUNT(*) FILTER (WHERE status = 'success') AS success_count
       FROM pg_orders`,
  );
  volumes.payment_gateway = {
    success_count: Number(pgVolume.rows[0].success_count),
    success_amount_paise: Number(pgVolume.rows[0].success_amount),
    total_count: Number(pgVolume.rows[0].success_count),
  };

  const totalUsers = usersByRole.rows.reduce((s, r) => s + Number(r.n), 0);

  return {
    users_by_role: Object.fromEntries(usersByRole.rows.map((r) => [r.role, Number(r.n)])),
    total_users: totalUsers,
    wallet_float_paise: Number(walletFloat.rows[0].total),
    pending_kyc: Number(pendingKyc.rows[0].n),
    commission_paid_paise: Number(commissionPaid.rows[0].total),
    txn_total_count: totalTxn,
    txn_success_count: successTxn,
    txn_pending_count: tn('pending_count'),
    txn_success_rate: totalTxn ? Math.round((successTxn / totalTxn) * 100) : 0,
    gtv_paise: tn('success_amount'),
    today_count: tn('today_count'),
    today_amount_paise: tn('today_amount'),
    month_amount_paise: tn('month_amount'),
    service_volumes: volumes,
  };
}
