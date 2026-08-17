import { query } from '../../../db';
import { settleByReference } from '../_shared/settle';

/**
 * EOD 3-way-style reconciliation (internal ledger vs bank/switch MIS).
 *
 * For each MIS row (reference + bank status + amount) we match the internal
 * transaction and remediate:
 *   - matched        : internal success + bank settled -> nothing to do
 *   - force_settled  : internal pending + bank settled -> force success
 *                      (settleByReference credits/pays-upline, idempotent)
 *   - false_success  : internal success + bank reversed/not_found -> flag for
 *                      dual-control clawback (maker-checker)
 *   - amount_mismatch: settled but amount differs -> flag
 *   - unrecognized   : no internal transaction for this reference
 */
export interface MisRow {
  reference: string;
  bank_status: 'settled' | 'reversed' | 'not_found';
  amount_paise?: number;
  rrn?: string;
}

export interface ReconSummary {
  batchId: string;
  total: number;
  matched: number;
  forceSettled: number;
  exceptions: number;
}

export async function runReconciliation(
  label: string,
  rows: MisRow[],
  createdBy?: string,
): Promise<ReconSummary> {
  const batch = await query<{ id: string }>(
    `INSERT INTO recon_batches (label, source, total_records, created_by)
     VALUES ($1,'bank_mis',$2,$3) RETURNING id`,
    [label, rows.length, createdBy ?? null],
  );
  const batchId = batch.rows[0].id;

  let matched = 0;
  let forceSettled = 0;
  let exceptions = 0;

  for (const r of rows) {
    const { rows: txns } = await query<{ id: string; status: string; amount_paise: string }>(
      'SELECT id, status, amount_paise FROM transactions WHERE reference = $1',
      [r.reference],
    );
    const txn = txns[0];

    let matchStatus: string;
    let action = 'none';
    const detail: Record<string, unknown> = { bank_status: r.bank_status };

    if (!txn) {
      matchStatus = 'unrecognized';
      exceptions++;
    } else if (r.amount_paise != null && Number(txn.amount_paise) !== r.amount_paise) {
      matchStatus = 'amount_mismatch';
      detail.internal_amount = Number(txn.amount_paise);
      detail.mis_amount = r.amount_paise;
      exceptions++;
    } else if (r.bank_status === 'settled') {
      if (txn.status === 'success') {
        matchStatus = 'matched';
        matched++;
      } else if (txn.status === 'pending') {
        // Case B: bank settled, platform timed out -> force settle.
        await settleByReference(r.reference, 'reconciliation', { status: 'success', providerRef: r.rrn });
        matchStatus = 'force_settled';
        action = 'force_settle';
        forceSettled++;
      } else {
        // internal failed/refunded but bank settled -> needs review.
        matchStatus = 'false_success';
        action = 'review_clawback';
        exceptions++;
      }
    } else {
      // bank reversed / not_found
      if (txn.status === 'success') {
        matchStatus = 'false_success';
        action = 'review_clawback';
        exceptions++;
      } else {
        matchStatus = 'matched';
        matched++;
      }
    }

    await query(
      `INSERT INTO recon_records (batch_id, reference, rrn, bank_status, amount_paise, txn_id, match_status, action, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [batchId, r.reference, r.rrn ?? null, r.bank_status, r.amount_paise ?? null, txn?.id ?? null, matchStatus, action, JSON.stringify(detail)],
    );
  }

  await query(
    'UPDATE recon_batches SET matched = $1, force_settled = $2, exceptions = $3 WHERE id = $4',
    [matched, forceSettled, exceptions, batchId],
  );

  return { batchId, total: rows.length, matched, forceSettled, exceptions };
}
