import { PoolClient } from 'pg';
import { query } from '../../../db';
import { credit } from '../wallet/wallet.service';
import { creditSub } from '../wallet/subwallet.service';
import { commissionTds, recordTds, recordGst } from '../tax/tax.service';
import { postJournal, JournalLine } from '../_shared/ledger';

export type Level = 'retailer' | 'distributor' | 'master_distributor' | 'admin';
const LEVELS: Level[] = ['retailer', 'distributor', 'master_distributor', 'admin'];

export interface CommissionEntry {
  level: Level;
  beneficiaryId: string;
  amountPaise: number;
}

export interface Distribution {
  ruleMatched: boolean;
  chargePaise: number; // customer charge from the plan
  retailerPaise: number; // retailer commission (netted into the debit)
  entries: CommissionEntry[]; // all levels with a beneficiary and positive amount
}

interface RuleRow {
  charge_type: string;
  charge_value: string;
  retailer_type: string;
  retailer_value: string;
  distributor_type: string;
  distributor_value: string;
  master_distributor_type: string;
  master_distributor_value: string;
  admin_type: string;
  admin_value: string;
}

function valueToPaise(type: string, value: string, amountPaise: number): number {
  const v = Number(value);
  if (type === 'percent') return Math.round((amountPaise * v) / 100);
  return Math.round(v * 100); // flat rupees -> paise
}

async function resolveRule(
  performerId: string,
  serviceCode: string,
  amountPaise: number,
): Promise<RuleRow | null> {
  const { rows } = await query<RuleRow>(
    `SELECT r.*
       FROM commission_rules r
       JOIN commission_plans p ON p.id = r.plan_id
      WHERE r.service_code = $2
        AND $3 BETWEEN r.min_amount_paise AND r.max_amount_paise
        AND p.id = COALESCE(
              (SELECT commission_plan_id FROM users WHERE id = $1),
              (SELECT id FROM commission_plans WHERE is_default LIMIT 1))
      ORDER BY r.min_amount_paise DESC
      LIMIT 1`,
    [performerId, serviceCode, amountPaise],
  );
  return rows[0] ?? null;
}

async function ancestorChain(performerId: string): Promise<{ id: string; role: string }[]> {
  const { rows } = await query<{ id: string; role: string }>(
    `WITH RECURSIVE chain AS (
        SELECT id, role, parent_id, 0 AS depth FROM users WHERE id = $1
        UNION ALL
        SELECT u.id, u.role, u.parent_id, c.depth + 1
          FROM users u JOIN chain c ON u.id = c.parent_id
         WHERE c.depth < 10)
      SELECT id, role FROM chain ORDER BY depth`,
    [performerId],
  );
  return rows;
}

/**
 * Compute the charge and commission breakdown for a transaction WITHOUT any
 * side effects. Called before debiting so the retailer can be netted.
 *
 * Beneficiaries (nearest wins): retailer level -> the performer; distributor /
 * master_distributor -> nearest ancestor of that role; admin -> nearest admin
 * ancestor, else the global admin.
 */
export async function computeDistribution(
  performerId: string,
  serviceCode: string,
  amountPaise: number,
): Promise<Distribution> {
  const rule = await resolveRule(performerId, serviceCode, amountPaise);
  if (!rule) {
    return { ruleMatched: false, chargePaise: 0, retailerPaise: 0, entries: [] };
  }

  const chain = await ancestorChain(performerId);
  const nearest = (role: string) => chain.find((c) => c.role === role)?.id;

  let adminId = nearest('admin');
  if (!adminId) {
    const { rows } = await query<{ id: string }>(
      "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1",
    );
    adminId = rows[0]?.id;
  }

  const beneficiaryFor: Record<Level, string | undefined> = {
    retailer: performerId,
    distributor: nearest('distributor'),
    master_distributor: nearest('master_distributor'),
    admin: adminId,
  };

  const entries: CommissionEntry[] = [];
  for (const level of LEVELS) {
    const beneficiaryId = beneficiaryFor[level];
    if (!beneficiaryId) continue;
    const type = rule[`${level}_type` as keyof RuleRow] as string;
    const value = rule[`${level}_value` as keyof RuleRow] as string;
    const amt = valueToPaise(type, value, amountPaise);
    if (amt > 0) entries.push({ level, beneficiaryId, amountPaise: amt });
  }

  const chargePaise = valueToPaise(rule.charge_type, rule.charge_value, amountPaise);
  const retailerPaise = entries.find((e) => e.level === 'retailer')?.amountPaise ?? 0;
  return { ruleMatched: true, chargePaise, retailerPaise, entries };
}

/**
 * On a successful transaction, record every commission entry (for earnings
 * reporting) and credit the UPLINE wallets only — the retailer's commission was
 * already realised as a reduced (net) debit, so we never credit it again.
 * Idempotent via UNIQUE(service_txn_id, level). MUST run inside a DB txn.
 */
export async function applyUplineCredits(
  client: PoolClient,
  p: { serviceTxnId: string; service: string; performerId: string; entries: CommissionEntry[] },
): Promise<void> {
  for (const e of p.entries) {
    const ins = await client.query(
      `INSERT INTO commission_entries
         (service_txn_id, service_code, performer_id, beneficiary_id, level, amount_paise)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (service_txn_id, level) DO NOTHING`,
      [p.serviceTxnId, p.service, p.performerId, e.beneficiaryId, e.level, e.amountPaise],
    );
    if (ins.rowCount !== 1) continue; // already distributed (idempotent)

    if (e.level === 'admin') {
      // Admin share = platform margin; carve out 18% GST for reporting and
      // still credit the admin operational wallet (unchanged money movement).
      await recordGst(client, {
        serviceTxnId: p.serviceTxnId,
        serviceCode: p.service,
        inclusivePaise: e.amountPaise,
      });
      await credit(client, {
        userId: e.beneficiaryId,
        amountPaise: e.amountPaise,
        source: 'commission',
        referenceId: p.serviceTxnId,
        description: `platform margin for ${p.service} (${p.serviceTxnId})`,
      });
      continue;
    }

    if (e.level === 'retailer') continue; // realised via the reduced (net) debit

    // Distributor / master distributor: withhold 194H TDS, pay net into the
    // member's Commission sub-wallet, and record the double-entry + TDS.
    const { rateBps, tdsPaise: tds } = await commissionTds(e.beneficiaryId, e.amountPaise);
    const net = e.amountPaise - tds;

    await creditSub(client, e.beneficiaryId, 'commission', net);
    await recordTds(client, {
      userId: e.beneficiaryId,
      serviceTxnId: p.serviceTxnId,
      serviceCode: p.service,
      section: '194H',
      grossPaise: e.amountPaise,
      rateBps,
      tdsPaise: tds,
    });
    // Commission paid out of platform margin, net of withheld TDS.
    const lines: JournalLine[] = [
      { account: 'platform_margin', direction: 'debit', amountPaise: e.amountPaise },
      { account: 'commission_wallet', direction: 'credit', amountPaise: net, walletUserId: e.beneficiaryId },
    ];
    if (tds > 0) lines.push({ account: 'tds_payable', direction: 'credit', amountPaise: tds });
    await postJournal(client, {
      source: 'commission',
      reference: p.serviceTxnId,
      narration: `${e.level} commission for ${p.service} (net of ${(rateBps / 100).toFixed(0)}% TDS)`,
      lines,
    });
  }
}

/** A member's commission earnings summary + recent entries. */
export async function earningsFor(userId: string, limit = 20, offset = 0) {
  const totals = await query<{ total_paise: string; count: string }>(
    `SELECT COALESCE(SUM(amount_paise),0) AS total_paise, COUNT(*) AS count
       FROM commission_entries WHERE beneficiary_id = $1`,
    [userId],
  );
  const { rows } = await query(
    `SELECT id, service_txn_id, service_code, level, amount_paise, created_at
       FROM commission_entries
      WHERE beneficiary_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return {
    total_paise: Number(totals.rows[0].total_paise),
    count: Number(totals.rows[0].count),
    items: rows.map((r) => ({ ...r, amount_paise: Number(r.amount_paise as string) })),
  };
}
