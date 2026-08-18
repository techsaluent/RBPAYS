import { query } from '../../../db';
import { logger } from '../../config/logger';

export interface AuditEntry {
  actorId?: string;
  actorRole?: string;
  action: string; // e.g. 'kyc.review', 'topup.approve', 'hold.place'
  targetType?: string; // 'user' | 'kyc' | 'topup' | 'hold' | 'staff' | 'provider' | ...
  targetId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Append an entry to the admin/staff activity audit log. Best-effort: a
 * logging failure must never break the action being audited, so errors are
 * swallowed (and logged) rather than thrown.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO admin_audit_log (actor_id, actor_role, action, target_type, target_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        entry.actorId ?? null,
        entry.actorRole ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        JSON.stringify(entry.detail ?? {}),
      ],
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, action: entry.action }, 'audit log write failed');
  }
}
