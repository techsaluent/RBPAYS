import { createHash } from 'crypto';
import { query } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { aiChat } from '../ai/ai.service';

/**
 * Error telemetry: the panel (source 'web') and the API (source 'api') record
 * their own errors here, grouped by signature so a recurring error bumps a
 * count rather than flooding the table. The admin can then ask the AI to
 * diagnose + draft a fix (safe: the fix is a suggestion a human reviews, never
 * auto-applied to production).
 */

const cap = (s: string | null | undefined, n: number): string | null =>
  s == null ? null : String(s).slice(0, n);

/** Stable dedupe key: source + normalised message + the first stack frame. */
function signatureOf(source: string, message: string, stack?: string | null): string {
  const topFrame = (stack || '').split('\n').map((l) => l.trim()).find((l) => /^at\s|:\d+:\d+/.test(l)) || '';
  // Strip volatile bits (ids, line:col, hex) so the same bug groups together.
  const norm = (message + ' ' + topFrame)
    .replace(/0x[0-9a-f]+/gi, '0x')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, 'UUID')
    .replace(/:\d+:\d+/g, ':L:C')
    .replace(/\d+/g, 'N')
    .slice(0, 500);
  return createHash('sha1').update(`${source}|${norm}`).digest('hex');
}

export interface ErrorInput {
  source: 'web' | 'api';
  message: string;
  stack?: string | null;
  route?: string | null;
  release?: string | null;
  userId?: string | null;
  userAgent?: string | null;
}

/** Upsert an error by signature. Best-effort: never throws to its caller path. */
export async function recordError(input: ErrorInput): Promise<void> {
  try {
    const message = cap(input.message, 2000);
    if (!message) return;
    const sig = signatureOf(input.source, message, input.stack);
    await query(
      `INSERT INTO error_reports (signature, source, message, stack, route, release, sample_user_id, sample_user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (signature) DO UPDATE SET
         count = error_reports.count + 1,
         last_seen = now(),
         -- refresh the sample context, and re-open a resolved group that recurs
         message = EXCLUDED.message,
         stack = COALESCE(EXCLUDED.stack, error_reports.stack),
         route = COALESCE(EXCLUDED.route, error_reports.route),
         status = CASE WHEN error_reports.status = 'resolved' THEN 'open' ELSE error_reports.status END`,
      [sig, input.source, message, cap(input.stack, 8000), cap(input.route, 300),
        cap(input.release, 60), input.userId ?? null, cap(input.userAgent, 300)],
    );
  } catch {
    // Telemetry must never break the request or the error handler.
  }
}

export async function listErrors(filter: { status?: string; source?: string; limit?: number } = {}) {
  const { rows } = await query(
    `SELECT id, signature, source, message, route, release, count, status, ai_diagnosis IS NOT NULL AS has_ai,
            escalated_ref, first_seen, last_seen
       FROM error_reports
      WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR source = $2)
      ORDER BY last_seen DESC LIMIT $3`,
    [filter.status ?? null, filter.source ?? null, Math.min(filter.limit ?? 100, 500)],
  );
  return rows;
}

export async function getError(id: string) {
  const { rows } = await query('SELECT * FROM error_reports WHERE id = $1', [id]);
  if (!rows[0]) throw ApiError.notFound('Error report not found');
  return rows[0];
}

export async function setErrorStatus(id: string, status: 'open' | 'triaged' | 'resolved' | 'ignored') {
  const { rows } = await query('UPDATE error_reports SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
  if (!rows[0]) throw ApiError.notFound('Error report not found');
  return rows[0];
}

const DIAGNOSE_SYSTEM =
  'You are a senior engineer triaging a production error in a Node.js + TypeScript + Express + Postgres ' +
  'fintech backend (and a vanilla-JS web panel). Given an error message, stack and route, respond in strict JSON ' +
  '{"diagnosis":"<likely root cause, 2-4 sentences>","suggested_fix":"<concrete change: file/area + what to do; a short code sketch is fine>","confidence":"low|medium|high"}. ' +
  'Never invent a fix that weakens auth, validation or money handling. If unsure, say so and suggest what to log next.';

/**
 * Ask the AI to diagnose an error and draft a fix. Stores the result on the
 * row. The fix is a SUGGESTION for a human to review — it is never applied
 * automatically.
 */
export async function diagnoseError(id: string) {
  const e = await getError(id);
  const user = [
    `Source: ${e.source}`,
    `Route: ${e.route || '(unknown)'}`,
    `Seen ${e.count} time(s).`,
    `Message: ${e.message}`,
    e.stack ? `Stack:\n${String(e.stack).slice(0, 4000)}` : '',
  ].filter(Boolean).join('\n');

  const raw = await aiChat(DIAGNOSE_SYSTEM, user);
  if (!raw) throw ApiError.badRequest('AI is not configured. Set it up in Integrations, then retry.');

  let diagnosis = raw.trim();
  let fix: string | null = null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]) as { diagnosis?: string; suggested_fix?: string; confidence?: string };
      if (parsed.diagnosis) diagnosis = parsed.diagnosis + (parsed.confidence ? ` (confidence: ${parsed.confidence})` : '');
      if (parsed.suggested_fix) fix = parsed.suggested_fix;
    }
  } catch {
    // Model didn't return clean JSON — keep the raw text as the diagnosis.
  }

  const { rows } = await query(
    'UPDATE error_reports SET ai_diagnosis = $2, ai_suggested_fix = $3 WHERE id = $1 RETURNING *',
    [id, cap(diagnosis, 4000), cap(fix, 4000)],
  );
  return rows[0];
}
