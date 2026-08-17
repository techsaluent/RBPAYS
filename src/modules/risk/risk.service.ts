import { PoolClient } from 'pg';
import { query } from '../../../db';
import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';

/**
 * Real-time risk / AML engine.
 *
 * A lightweight, DB-backed scorer that runs before a transaction is committed.
 * It evaluates velocity, off-hours and amount signals into a 0..100 score and
 * an action: allow (<30), review (30..69), hold (70..89) or block (>=90).
 * Egregious patterns (block) are rejected; everything else is logged for the
 * ops desk. Thresholds are env-tunable so normal traffic passes freely.
 */
export type RiskAction = 'allow' | 'review' | 'hold' | 'block';

export interface RiskAssessment {
  score: number;
  action: RiskAction;
  reasons: string[];
}

function actionFor(score: number): RiskAction {
  if (score >= 90) return 'block';
  if (score >= 70) return 'hold';
  if (score >= 30) return 'review';
  return 'allow';
}

/** IST hour (UTC+5:30) for off-hours evaluation. */
function istHour(): number {
  const utcMs = Date.now();
  const ist = new Date(utcMs + (5 * 60 + 30) * 60 * 1000);
  return ist.getUTCHours();
}

function inOffHours(hour: number): boolean {
  const s = env.RISK_OFF_HOURS_START;
  const e = env.RISK_OFF_HOURS_END;
  return s <= e ? hour >= s && hour < e : hour >= s || hour < e;
}

/**
 * Assess a transaction before it is committed. Logs a risk_event when the
 * action is not a plain allow, and throws 422 when the action is 'block'.
 */
export async function assessTransaction(p: {
  userId: string;
  service: string;
  amountPaise: number;
  reference?: string;
}): Promise<RiskAssessment> {
  if (!env.RISK_ENGINE_ENABLED) return { score: 0, action: 'allow', reasons: [] };

  let score = 0;
  const reasons: string[] = [];

  // Velocity: same-service transactions by this user in the rolling window.
  const { rows: vel } = await query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM transactions
      WHERE user_id = $1 AND service = $2
        AND created_at >= now() - ($3 || ' minutes')::interval`,
    [p.userId, p.service, String(env.RISK_VELOCITY_WINDOW_MIN)],
  );
  const count = Number(vel[0]?.n ?? '0');
  if (count >= env.RISK_VELOCITY_MAX_COUNT) {
    score += 60;
    reasons.push(`velocity ${count} ${p.service} txns in ${env.RISK_VELOCITY_WINDOW_MIN}m`);
  } else if (count >= env.RISK_VELOCITY_MAX_COUNT * 0.75) {
    score += 25;
    reasons.push('velocity elevated');
  }

  // Off-hours cash-out is higher risk.
  if (inOffHours(istHour()) && ['aeps', 'matm', 'payout', 'dmt'].includes(p.service)) {
    score += 25;
    reasons.push('off-hours cash movement');
  }

  const action = actionFor(score);

  if (action !== 'allow') {
    await query(
      `INSERT INTO risk_events (user_id, service_code, reference, kind, score, action, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.userId, p.service, p.reference ?? null, 'velocity', score, action, JSON.stringify({ reasons, count })],
    );
  }
  if (action === 'block') {
    throw ApiError.unprocessable('Transaction blocked by risk engine', { score, reasons });
  }
  return { score, action, reasons };
}

/**
 * AePS split-transaction / commission-farming guard: if the same Aadhaar ref
 * was already charged by this retailer within the window, the transaction is
 * allowed but hierarchy commission is stripped. Returns true to suppress.
 */
export async function aepsSplitSuppressesCommission(userId: string, aadhaarRef: string): Promise<boolean> {
  if (!env.RISK_ENGINE_ENABLED) return false;
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM aeps_transactions
      WHERE user_id = $1 AND aadhaar_ref = $2 AND status = 'success'
        AND created_at >= now() - ($3 || ' minutes')::interval`,
    [userId, aadhaarRef, String(env.RISK_AEPS_SPLIT_WINDOW_MIN)],
  );
  const repeat = Number(rows[0]?.n ?? '0') >= 1;
  if (repeat) {
    await query(
      `INSERT INTO risk_events (user_id, service_code, kind, score, action, detail)
       VALUES ($1,'aeps','aeps_split',40,'review',$2)`,
      [userId, JSON.stringify({ aadhaar_ref: aadhaarRef, note: 'commission stripped' })],
    );
  }
  return repeat;
}

/**
 * DMT structuring / smurfing guard: transfers in the "just under the ceiling"
 * band, repeated more than the allowed count within the last hour by the same
 * remitter mobile (or the same retailer when no remitter is captured), are
 * blocked as likely structuring.
 */
export async function assertNotDmtStructuring(p: {
  userId: string;
  amountPaise: number;
  remitterMobile?: string;
}): Promise<void> {
  if (!env.RISK_ENGINE_ENABLED) return;
  const inBand =
    p.amountPaise >= env.RISK_DMT_STRUCT_MIN_PAISE && p.amountPaise <= env.RISK_DMT_STRUCT_MAX_PAISE;
  if (!inBand) return;

  const filterCol = p.remitterMobile ? 'remitter_mobile' : 'user_id';
  const filterVal = p.remitterMobile ?? p.userId;
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM dmt_transactions
      WHERE ${filterCol} = $1
        AND amount_paise BETWEEN $2 AND $3
        AND created_at >= now() - interval '1 hour'`,
    [filterVal, env.RISK_DMT_STRUCT_MIN_PAISE, env.RISK_DMT_STRUCT_MAX_PAISE],
  );
  if (Number(rows[0]?.n ?? '0') >= env.RISK_DMT_STRUCT_MAX_PER_HOUR) {
    await query(
      `INSERT INTO risk_events (user_id, service_code, kind, score, action, detail)
       VALUES ($1,'dmt','dmt_structuring',95,'block',$2)`,
      [p.userId, JSON.stringify({ amount_paise: p.amountPaise, remitter: p.remitterMobile ?? null })],
    );
    throw ApiError.unprocessable(
      'Transfer blocked: repeated just-under-limit transfers look like structuring (AML). Please contact support.',
    );
  }
}

/** Log a generic risk flag (used by callers that detect their own signals). */
export async function logRisk(
  client: PoolClient,
  p: { userId?: string; service?: string; kind: string; score: number; action: RiskAction; detail?: unknown },
): Promise<void> {
  await client.query(
    `INSERT INTO risk_events (user_id, service_code, kind, score, action, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [p.userId ?? null, p.service ?? null, p.kind, p.score, p.action, JSON.stringify(p.detail ?? {})],
  );
}
