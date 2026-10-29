import crypto from 'crypto';
import { env } from '../../config/env';
import { query } from '../../../db';

/**
 * Stateless math "human verification" (bot throttle) for login / signup.
 *
 * The server issues a simple arithmetic question plus a signed token that
 * encodes the answer and an expiry (HMAC-SHA256 with the access secret — no
 * DB row, no session). The client submits the answer + token; we re-check the
 * signature, expiry and answer. Opt-in: gated by site setting
 * `security_require_captcha` (off by default).
 */

const SECRET = env.JWT_ACCESS_SECRET;
const OPS: Array<[string, (a: number, b: number) => number]> = [
  ['+', (a, b) => a + b],
  ['−', (a, b) => a - b],
  ['×', (a, b) => a * b],
];

function sign(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export interface Captcha { a: number; b: number; op: string; token: string; }

/** Issue a fresh question + signed token (valid 5 minutes). */
export function issueCaptcha(): Captcha {
  const [op, fn] = OPS[Math.floor(Math.random() * OPS.length)];
  let a = Math.floor(Math.random() * 9) + 1;
  let b = Math.floor(Math.random() * 9) + 1;
  if (op === '−' && b > a) [a, b] = [b, a]; // keep the answer non-negative
  const ans = fn(a, b);
  const exp = Date.now() + 5 * 60 * 1000;
  const payload = `${ans}.${exp}`;
  const token = Buffer.from(payload).toString('base64url') + '.' + sign(payload);
  return { a, b, op, token };
}

/** Verify a submitted answer against its token. */
export function verifyCaptcha(token: unknown, answer: unknown): boolean {
  if (typeof token !== 'string' || token.length > 300) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const p = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload: string;
  try { payload = Buffer.from(p, 'base64url').toString('utf8'); } catch { return false; }
  // Constant-time signature compare.
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const [ansStr, expStr] = payload.split('.');
  if (!expStr || Date.now() > Number(expStr)) return false;
  const given = Number(String(answer).trim());
  return Number.isFinite(given) && given === Number(ansStr);
}

/** Is captcha required? Off by default. */
export async function captchaRequired(): Promise<boolean> {
  const { rows } = await query<{ value: string }>(
    "SELECT value FROM site_settings WHERE key = 'security_require_captcha'",
  );
  return (rows[0]?.value ?? 'false').trim() === 'true';
}
