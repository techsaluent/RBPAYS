import { withTransaction, query } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { debitSub, creditSub } from '../wallet/subwallet.service';
import { postJournal } from '../_shared/ledger';

/**
 * Automated batch payout engine.
 *
 * Records are held atomically: each member's settlement balance is debited and
 * moved into the payout_clearing (in-transit) liability. A NEFT/RTGS file is
 * generated (rail by ticket size); the bank's reverse feed then settles each
 * record (funds leave the payout escrow) or returns it (refunded to the
 * member's settlement wallet).
 */
export interface BatchRecordInput {
  user_id: string;
  amount_paise: number;
  beneficiary_name: string;
  account_number: string;
  ifsc: string;
}

const RTGS_FLOOR_PAISE = 200_000_00; // >= ₹2,00,000 goes RTGS

export async function createPayoutBatch(
  label: string,
  records: BatchRecordInput[],
  createdBy?: string,
): Promise<{ batchId: string; total_paise: number; record_count: number }> {
  return withTransaction(async (client) => {
    const batch = await client.query<{ id: string }>(
      'INSERT INTO payout_batches (label, created_by) VALUES ($1,$2) RETURNING id',
      [label, createdBy ?? null],
    );
    const batchId = batch.rows[0].id;
    let total = 0;
    let seq = 0;

    for (const r of records) {
      // Hold funds: debit the member's settlement wallet into payout clearing.
      await debitSub(client, r.user_id, 'settlement', r.amount_paise);
      await postJournal(client, {
        source: 'payout_batch',
        reference: batchId,
        narration: `Batch hold for ${r.beneficiary_name}`,
        lines: [
          { account: 'settlement_wallet', direction: 'debit', amountPaise: r.amount_paise, walletUserId: r.user_id },
          { account: 'payout_clearing', direction: 'credit', amountPaise: r.amount_paise },
        ],
      });
      const rail = r.amount_paise >= RTGS_FLOOR_PAISE ? 'RTGS' : 'NEFT';
      seq += 1;
      total += r.amount_paise;
      await client.query(
        `INSERT INTO payout_batch_records
           (batch_id, user_id, amount_paise, rail, beneficiary_name, account_number, ifsc, seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [batchId, r.user_id, r.amount_paise, rail, r.beneficiary_name, r.account_number, r.ifsc, seq],
      );
    }

    const mixed = new Set(records.map((r) => (r.amount_paise >= RTGS_FLOOR_PAISE ? 'RTGS' : 'NEFT')));
    const rail = mixed.size === 1 ? [...mixed][0] : 'mixed';
    await client.query(
      'UPDATE payout_batches SET total_paise = $1, record_count = $2, rail = $3 WHERE id = $4',
      [total, records.length, rail, batchId],
    );
    return { batchId, total_paise: total, record_count: records.length };
  });
}

/** Generate the bank CMS file (delimited) and mark the batch transmitted. */
export async function generateBatchFile(batchId: string): Promise<string> {
  const batch = await query<{ id: string; label: string }>('SELECT id, label FROM payout_batches WHERE id = $1', [batchId]);
  if (!batch.rows[0]) throw ApiError.notFound('Batch not found');
  const { rows } = await query<{
    seq: number; rail: string; beneficiary_name: string; account_number: string; ifsc: string; amount_paise: string; id: string;
  }>('SELECT seq, rail, beneficiary_name, account_number, ifsc, amount_paise, id FROM payout_batch_records WHERE batch_id = $1 ORDER BY seq', [batchId]);

  const header = 'SEQ|PRODUCT|BENEFICIARY|ACCOUNT|IFSC|AMOUNT|REF';
  const lines = rows.map((r) =>
    [r.seq, r.rail, r.beneficiary_name, r.account_number, r.ifsc, (Number(r.amount_paise) / 100).toFixed(2), r.id].join('|'),
  );
  await query("UPDATE payout_batches SET status = 'transmitted' WHERE id = $1 AND status = 'queued'", [batchId]);
  return [header, ...lines].join('\n');
}

/** Ingest the bank reverse feed: settle or return each record. */
export async function ingestReverseFeed(
  batchId: string,
  feed: { record_id: string; status: 'settled' | 'returned'; utr?: string }[],
): Promise<{ settled: number; returned: number }> {
  let settled = 0;
  let returned = 0;

  for (const f of feed) {
    await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; user_id: string; amount_paise: string; status: string }>(
        'SELECT id, user_id, amount_paise, status FROM payout_batch_records WHERE id = $1 AND batch_id = $2 FOR UPDATE',
        [f.record_id, batchId],
      );
      const rec = rows[0];
      if (!rec || rec.status !== 'queued') return;
      const amt = Number(rec.amount_paise);

      if (f.status === 'settled') {
        await postJournal(client, {
          source: 'payout_batch',
          reference: batchId,
          narration: 'Batch record settled (funds dispatched)',
          lines: [
            { account: 'payout_clearing', direction: 'debit', amountPaise: amt },
            { account: 'payout_escrow', direction: 'credit', amountPaise: amt },
          ],
        });
        await client.query("UPDATE payout_batch_records SET status='settled', utr=$1 WHERE id=$2", [f.utr ?? null, rec.id]);
        settled += 1;
      } else {
        // Returned: refund the member's settlement wallet from clearing.
        await creditSub(client, rec.user_id, 'settlement', amt);
        await postJournal(client, {
          source: 'payout_batch',
          reference: batchId,
          narration: 'Batch record returned (refund to settlement wallet)',
          lines: [
            { account: 'payout_clearing', direction: 'debit', amountPaise: amt },
            { account: 'settlement_wallet', direction: 'credit', amountPaise: amt, walletUserId: rec.user_id },
          ],
        });
        await client.query("UPDATE payout_batch_records SET status='returned', utr=$1 WHERE id=$2", [f.utr ?? null, rec.id]);
        returned += 1;
      }
    });
  }

  await query(
    `UPDATE payout_batches SET
        settled_count = (SELECT COUNT(*) FROM payout_batch_records WHERE batch_id = $1 AND status='settled'),
        returned_count = (SELECT COUNT(*) FROM payout_batch_records WHERE batch_id = $1 AND status='returned'),
        status = CASE WHEN (SELECT COUNT(*) FROM payout_batch_records WHERE batch_id = $1 AND status='queued') = 0
                      THEN 'settled' ELSE status END
      WHERE id = $1`,
    [batchId],
  );
  return { settled, returned };
}

/** Platform asset-account balances derived from the journal (paise). */
export async function treasuryBalances() {
  const { rows } = await query<{ account_code: string; name: string; bal: string }>(
    `SELECT c.code AS account_code, c.name,
            COALESCE(SUM(CASE WHEN l.direction='debit' THEN l.amount_paise ELSE -l.amount_paise END),0)::text AS bal
       FROM chart_of_accounts c
       LEFT JOIN journal_lines l ON l.account_code = c.code
      WHERE c.type = 'asset'
      GROUP BY c.code, c.name
      ORDER BY c.code`,
  );
  return rows.map((r) => ({ account: r.account_code, name: r.name, balance_paise: Number(r.bal) }));
}

/** Two-phase asset-to-asset treasury sweep via the in-transit clearing account. */
export async function treasurySweep(fromAccount: string, toAccount: string, amountPaise: number, utr?: string) {
  const valid = new Set(['bank_escrow', 'payout_escrow', 'treasury_in_transit']);
  if (!valid.has(fromAccount) || !valid.has(toAccount) || fromAccount === toAccount) {
    throw ApiError.badRequest('Invalid treasury accounts');
  }
  return withTransaction(async (client) => {
    // Phase 1: funds leave the source into in-transit.
    await postJournal(client, {
      source: 'treasury',
      narration: `Treasury sweep ${fromAccount} -> in-transit`,
      lines: [
        { account: 'treasury_in_transit', direction: 'debit', amountPaise },
        { account: fromAccount, direction: 'credit', amountPaise },
      ],
    });
    // Phase 2: settlement confirmed into the destination.
    await postJournal(client, {
      source: 'treasury',
      reference: utr,
      narration: `Treasury sweep in-transit -> ${toAccount}`,
      lines: [
        { account: toAccount, direction: 'debit', amountPaise },
        { account: 'treasury_in_transit', direction: 'credit', amountPaise },
      ],
    });
    return { from: fromAccount, to: toAccount, amount_paise: amountPaise };
  });
}
