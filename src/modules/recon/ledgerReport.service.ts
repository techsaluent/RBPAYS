import { query } from '../../../db';

/**
 * Internal accounting-integrity reports built on the double-entry journal
 * (journal_entries / journal_lines / chart_of_accounts):
 *
 *   1. Trial balance   — every account's debit & credit totals and its
 *                        net balance on its normal side. Grand-total debits
 *                        MUST equal grand-total credits (the books balance).
 *   2. Wallet recon    — proves the journal's per-member wallet balances
 *                        agree with the fast `wallets` / `sub_wallets`
 *                        tables that the app spends against; any drift is a
 *                        row the treasury team must investigate.
 *
 * These are read-only and safe to run any time; the auto-recon loop calls
 * the wallet recon to alarm on drift.
 */

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  normal_balance: 'debit' | 'credit';
  debit_paise: number;
  credit_paise: number;
  balance_paise: number; // signed on the account's normal side
}

export interface TrialBalance {
  as_of: string | null;
  rows: TrialBalanceRow[];
  total_debit_paise: number;
  total_credit_paise: number;
  balanced: boolean;
  difference_paise: number;
}

/** Trial balance across all accounts, optionally as of end of a given day. */
export async function trialBalance(asOf?: string): Promise<TrialBalance> {
  const { rows } = await query<{
    code: string; name: string; type: string; normal_balance: 'debit' | 'credit';
    debit: string; credit: string;
  }>(
    `SELECT a.code, a.name, a.type, a.normal_balance,
            COALESCE(SUM(l.amount_paise) FILTER (WHERE l.direction='debit'), 0)  AS debit,
            COALESCE(SUM(l.amount_paise) FILTER (WHERE l.direction='credit'), 0) AS credit
       FROM chart_of_accounts a
       LEFT JOIN journal_lines l ON l.account_code = a.code
        AND ($1::timestamptz IS NULL OR l.created_at < ($1::timestamptz + interval '1 day'))
      GROUP BY a.code, a.name, a.type, a.normal_balance
      ORDER BY a.type, a.code`,
    [asOf || null],
  );

  let totalDebit = 0;
  let totalCredit = 0;
  const out: TrialBalanceRow[] = rows.map((r) => {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    totalDebit += debit;
    totalCredit += credit;
    const balance = r.normal_balance === 'debit' ? debit - credit : credit - debit;
    return {
      code: r.code, name: r.name, type: r.type, normal_balance: r.normal_balance,
      debit_paise: debit, credit_paise: credit, balance_paise: balance,
    };
  });

  return {
    as_of: asOf || null,
    rows: out,
    total_debit_paise: totalDebit,
    total_credit_paise: totalCredit,
    balanced: totalDebit === totalCredit,
    difference_paise: totalDebit - totalCredit,
  };
}

export interface WalletReconRow {
  user_id: string;
  full_name: string | null;
  account: 'member_wallet' | 'settlement_wallet' | 'commission_wallet';
  ledger_paise: number; // from the journal
  balance_paise: number; // from the fast wallet table
  drift_paise: number; // ledger − balance (0 = reconciled)
}

export interface WalletRecon {
  checked: number;
  reconciled: number;
  drifted: number;
  total_drift_paise: number;
  drift_rows: WalletReconRow[]; // only the mismatches
}

/**
 * Compare the journal's member-wallet balances (SUM(credit) − SUM(debit),
 * these are credit-normal liabilities) against the live wallet tables.
 * Returns only the drifted rows plus the summary counts.
 */
export async function walletReconciliation(limit = 500): Promise<WalletRecon> {
  // Journal-derived balance per (user, account) for the three member accounts.
  const { rows } = await query<{
    user_id: string; full_name: string | null; account: string;
    ledger: string; balance: string;
  }>(
    `WITH ledger AS (
        SELECT wallet_user_id AS user_id, account_code AS account,
               COALESCE(SUM(amount_paise) FILTER (WHERE direction='credit'),0)
             - COALESCE(SUM(amount_paise) FILTER (WHERE direction='debit'),0) AS bal
          FROM journal_lines
         WHERE account_code IN ('member_wallet','settlement_wallet','commission_wallet')
           AND wallet_user_id IS NOT NULL
         GROUP BY wallet_user_id, account_code
      ),
      live AS (
        SELECT user_id, 'member_wallet'::text AS account, balance_paise AS bal FROM wallets
        UNION ALL
        SELECT user_id,
               CASE wallet_type WHEN 'settlement' THEN 'settlement_wallet' ELSE 'commission_wallet' END,
               balance_paise
          FROM sub_wallets
      )
      SELECT COALESCE(l.user_id, v.user_id) AS user_id, u.full_name,
             COALESCE(l.account, v.account) AS account,
             COALESCE(l.bal, 0) AS ledger, COALESCE(v.bal, 0) AS balance
        FROM ledger l
        FULL OUTER JOIN live v ON v.user_id = l.user_id AND v.account = l.account
        LEFT JOIN users u ON u.id = COALESCE(l.user_id, v.user_id)`,
  );

  let reconciled = 0;
  const drift: WalletReconRow[] = [];
  let totalDrift = 0;
  for (const r of rows) {
    const ledger = Number(r.ledger);
    const balance = Number(r.balance);
    const d = ledger - balance;
    if (d === 0) { reconciled++; continue; }
    totalDrift += Math.abs(d);
    if (drift.length < limit) {
      drift.push({
        user_id: r.user_id,
        full_name: r.full_name,
        account: r.account as WalletReconRow['account'],
        ledger_paise: ledger,
        balance_paise: balance,
        drift_paise: d,
      });
    }
  }

  return {
    checked: rows.length,
    reconciled,
    drifted: rows.length - reconciled,
    total_drift_paise: totalDrift,
    drift_rows: drift,
  };
}
