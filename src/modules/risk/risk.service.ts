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

const CASHOUT_SERVICES = new Set(['aeps', 'matm', 'payout']);

/**
 * Enforce the member's daily cap for cash-out (AePS/mATM/payout) and DMT.
 * Probation members get a lower ceiling; per-user overrides win. Throws 422
 * when the day's total (including this transaction) would exceed the cap.
 */
export async function enforceDailyCaps(userId: string, service: string, amountPaise: number): Promise<void> {
  const isCashout = CASHOUT_SERVICES.has(service);
  const isDmt = service === 'dmt';
  if (!isCashout && !isDmt) return;

  const { rows } = await query<{
    tier: string;
    daily_cashout_cap_paise: string | null;
    daily_dmt_cap_paise: string | null;
  }>('SELECT tier, daily_cashout_cap_paise, daily_dmt_cap_paise FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u) return;
  const probation = u.tier !== 'full';

  const cap = isCashout
    ? Number(u.daily_cashout_cap_paise ?? (probation ? env.PROBATION_CASHOUT_CAP_PAISE : env.FULL_CASHOUT_CAP_PAISE))
    : Number(u.daily_dmt_cap_paise ?? (probation ? env.PROBATION_DMT_CAP_PAISE : env.FULL_DMT_CAP_PAISE));

  const services = isCashout ? ['aeps', 'matm', 'payout'] : ['dmt'];
  const { rows: sums } = await query<{ sum: string }>(
    `SELECT COALESCE(SUM(amount_paise),0)::text sum FROM transactions
      WHERE user_id = $1 AND service = ANY($2)
        AND status IN ('pending','success')
        AND created_at >= date_trunc('day', now())`,
    [userId, services],
  );
  const already = Number(sums[0]?.sum ?? '0');
  if (already + amountPaise > cap) {
    await query(
      `INSERT INTO risk_events (user_id, service_code, kind, score, action, detail)
       VALUES ($1,$2,'daily_cap',80,'block',$3)`,
      [userId, service, JSON.stringify({ cap, already, amount: amountPaise, tier: u.tier })],
    );
    throw ApiError.unprocessable(
      `Daily ${isCashout ? 'cash-out' : 'DMT'} limit of ₹${(cap / 100).toLocaleString('en-IN')} reached` +
        (probation ? ' (probation tier)' : ''),
    );
  }
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

  // Probation / full-tier daily caps for cash-out and DMT.
  await enforceDailyCaps(p.userId, p.service, p.amountPaise);

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
 * AML / banned-business screening against the admin-managed blocklist.
 *
 * `targets` are the payee identifiers a transaction carries (account, IFSC,
 * UPI, mobile, PAN, name) plus free text (description). Exact-id kinds match
 * the normalized value exactly; `name` / `keyword` rules match as a substring
 * of any name/text target. A matched 'block' rule logs a risk event and throws
 * 422; 'flag' rules are logged (review) but allow the transaction through.
 * No rules configured → no-op (and no DB round-trip beyond the single query).
 */
export interface ScreenTarget { kind: 'account' | 'ifsc' | 'upi' | 'mobile' | 'pan' | 'name' | 'text'; value: string }

function normId(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, '');
}

export async function screenTargets(p: {
  userId: string;
  service: string;
  amountPaise: number;
  reference?: string;
  targets: ScreenTarget[];
}): Promise<{ action: 'allow' | 'flag' | 'block'; matches: Array<{ kind: string; value: string; reason: string | null }> }> {
  if (!env.RISK_ENGINE_ENABLED) return { action: 'allow', matches: [] };
  const targets = (p.targets || []).filter((t) => t.value && t.value.trim());
  if (!targets.length) return { action: 'allow', matches: [] };

  // All active rules (the list is small and admin-curated).
  const { rows } = await query<{ kind: string; value_norm: string; action: 'block' | 'flag'; reason: string | null; label: string | null }>(
    'SELECT kind, value_norm, action, reason, label FROM aml_blocklist WHERE is_active = true',
  );
  if (!rows.length) return { action: 'allow', matches: [] };

  // Exact-id targets by kind, and the concatenated free-text for name/keyword.
  const exact: Record<string, Set<string>> = {};
  const textParts: string[] = [];
  for (const t of targets) {
    if (t.kind === 'name' || t.kind === 'text') textParts.push(t.value.toLowerCase());
    else { (exact[t.kind] ??= new Set()).add(normId(t.value)); }
    // A name is also matched by exact `name` rules, and appears in free text.
    if (t.kind === 'name') (exact.name ??= new Set()).add(normId(t.value));
  }
  const text = textParts.join(' ');

  const matches: Array<{ kind: string; value: string; reason: string | null; action: 'block' | 'flag' }> = [];
  for (const r of rows) {
    let hit = false;
    if (r.kind === 'keyword' || r.kind === 'name') {
      if (r.value_norm && text.includes(r.value_norm)) hit = true;
      if (!hit && exact.name && exact.name.has(r.value_norm)) hit = true;
    } else if (exact[r.kind] && exact[r.kind].has(r.value_norm)) {
      hit = true;
    }
    if (hit) matches.push({ kind: r.kind, value: r.label || r.value_norm, reason: r.reason, action: r.action });
  }
  if (!matches.length) return { action: 'allow', matches: [] };

  const blocked = matches.some((m) => m.action === 'block');
  const action = blocked ? 'block' : 'flag';
  await query(
    `INSERT INTO risk_events (user_id, service_code, reference, kind, score, action, detail)
     VALUES ($1,$2,$3,'aml_blocklist',$4,$5,$6)`,
    [p.userId, p.service, p.reference ?? null, blocked ? 100 : 50, blocked ? 'block' : 'review',
     JSON.stringify({ matches: matches.map((m) => ({ kind: m.kind, value: m.value, reason: m.reason, action: m.action })), amount_paise: p.amountPaise })],
  );
  if (blocked) {
    throw ApiError.unprocessable('Transaction blocked by AML screening (banned/blocked payee). Contact compliance.', {
      matches: matches.filter((m) => m.action === 'block').map((m) => ({ kind: m.kind, reason: m.reason })),
    });
  }
  return { action, matches: matches.map((m) => ({ kind: m.kind, value: m.value, reason: m.reason })) };
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

