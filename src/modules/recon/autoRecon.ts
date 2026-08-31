import { query } from '../../../db';
import { logger } from '../../config/logger';
import { resolvePending } from '../transactions/refund.service';

/**
 * Auto-reconciliation of stuck transactions.
 *
 * A transaction that a provider never gave a final status for stays `pending`
 * and holds the member's money. This sweeps pendings older than a threshold and
 * resolves them to `failed` (which reverses the debit and refunds the member) —
 * the standard T+1 treatment. It reuses settleByReference, so it is idempotent
 * and terminal-safe: a late success/failed callback on an already-swept txn is a
 * no-op.
 */
export interface StalePending {
  id: string;
  reference: string;
  service: string;
  user_id: string;
  amount_paise: string;
  net_paise: string;
  created_at: string;
  age_minutes: number;
}

/** List pending transactions older than `olderThanMin` minutes. */
export async function listStalePending(olderThanMin: number, limit = 500): Promise<StalePending[]> {
  const { rows } = await query<StalePending>(
    `SELECT id, reference, service, user_id, amount_paise, net_paise, created_at,
            ROUND(EXTRACT(EPOCH FROM (now() - created_at)) / 60)::int AS age_minutes
       FROM transactions
      WHERE status = 'pending' AND created_at < now() - ($1 || ' minutes')::interval
      ORDER BY created_at ASC
      LIMIT $2`,
    [String(olderThanMin), limit],
  );
  return rows;
}

/** Resolve stale pendings to `failed` (reversing the debit). Returns what it swept. */
export async function sweepStalePending(
  olderThanMin: number,
  remark: string,
): Promise<{ swept: number; failed: number; items: Array<{ reference: string; ok: boolean; error?: string }> }> {
  const stale = await listStalePending(olderThanMin);
  const items: Array<{ reference: string; ok: boolean; error?: string }> = [];
  let failed = 0;
  for (const t of stale) {
    try {
      await resolvePending(t.id, 'failed', remark);
      items.push({ reference: t.reference, ok: true });
    } catch (err) {
      failed++;
      items.push({ reference: t.reference, ok: false, error: (err as Error).message });
      logger.warn({ reference: t.reference, err: (err as Error).message }, 'auto-recon: sweep item failed');
    }
  }
  if (stale.length) logger.info({ swept: stale.length - failed, failed, olderThanMin }, 'auto-recon sweep');
  return { swept: stale.length - failed, failed, items };
}

/**
 * Background sweeper. Reads the admin setting `auto_recon_hours` (0 = disabled,
 * the default) and, when > 0, sweeps pendings older than that many hours every
 * `intervalMin`. Off unless the admin turns it on. Returns a stop function.
 */
export function startAutoReconLoop(intervalMin = 15): () => void {
  const tick = async () => {
    try {
      const { rows } = await query<{ value: string | null }>(
        "SELECT value FROM site_settings WHERE key = 'auto_recon_hours'",
      );
      const hours = Number(rows[0]?.value) || 0;
      if (hours <= 0) return; // disabled
      await sweepStalePending(hours * 60, `Auto-recon: no final provider status after ${hours}h`);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'auto-recon loop tick failed');
    }
  };
  const handle = setInterval(() => void tick(), intervalMin * 60_000);
  handle.unref?.(); // never keep the process alive just for this
  logger.info({ intervalMin }, 'auto-recon loop started (gated by auto_recon_hours setting)');
  return () => clearInterval(handle);
}
