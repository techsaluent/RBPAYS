import { query } from '../../../db';
import { httpJson } from '../../providers/http';
import { logger } from '../../config/logger';

/**
 * Digital KYC verification.
 *
 * Calls a configured verification provider (platform_integrations key 'pan' /
 * 'aadhaar', or the shared 'verification' row) to instantly verify PAN and to
 * run Aadhaar OTP e-KYC. When no provider is configured it falls back to a
 * clearly-labelled SANDBOX that validates format only — so the flow is usable
 * in demo, and the admin plugs a real provider under Integrations to go live.
 */
interface VerifyConfig {
  baseUrl: string | null;
  apiKey: string | null;
  apiSecret: string | null;
}
async function verifyConfig(kind: 'pan' | 'aadhaar'): Promise<VerifyConfig | null> {
  const { rows } = await query<{ base_url: string | null; api_key: string | null; api_secret: string | null }>(
    `SELECT base_url, api_key, api_secret FROM platform_integrations
      WHERE key IN ($1, 'verification') AND is_active = true
      ORDER BY CASE key WHEN $1 THEN 0 ELSE 1 END LIMIT 1`,
    [kind],
  );
  const r = rows[0];
  if (!r?.base_url) return null;
  return { baseUrl: r.base_url, apiKey: r.api_key, apiSecret: r.api_secret };
}
function headers(c: VerifyConfig): Record<string, string> {
  return {
    ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}`, 'X-Api-Key': c.apiKey } : {}),
    ...(c.apiSecret ? { 'X-Api-Secret': c.apiSecret } : {}),
  };
}
/** Read a boolean-ish "verified"/"valid" field from a tolerant provider response. */
function isVerified(raw: Record<string, unknown>): boolean {
  const v = raw.verified ?? raw.valid ?? raw.status ?? raw.pan_valid ?? raw.success;
  const s = String(v ?? '').toLowerCase();
  return ['true', '1', 'valid', 'verified', 'success', 'yes', 'y'].includes(s);
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAAR_RE = /^[0-9]{12}$/;

export interface PanResult { verified: boolean; name?: string; message: string; sandbox: boolean; }
export async function verifyPan(pan: string, name?: string): Promise<PanResult> {
  const p = pan.trim().toUpperCase();
  if (!PAN_RE.test(p)) return { verified: false, message: 'Invalid PAN format', sandbox: false };
  const cfg = await verifyConfig('pan');
  if (!cfg) {
    // Sandbox: format-valid + a name provided passes.
    return { verified: !!name, name, message: name ? 'Verified (sandbox)' : 'Enter the name as on PAN', sandbox: true };
  }
  try {
    const raw = await httpJson<Record<string, unknown>>(cfg.baseUrl!, {
      method: 'POST', headers: headers(cfg), body: { pan: p, name },
    });
    const ok = isVerified(raw);
    return { verified: ok, name: (raw.name as string) || name, message: ok ? 'PAN verified' : String(raw.message || 'PAN not verified'), sandbox: false };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'PAN verify failed');
    return { verified: false, message: 'Verification service error', sandbox: false };
  }
}

export interface OtpSend { ref: string; message: string; sandbox: boolean; }
export async function aadhaarSendOtp(aadhaar: string): Promise<OtpSend> {
  const a = aadhaar.trim();
  if (!AADHAAR_RE.test(a)) throw new Error('Invalid Aadhaar number');
  const cfg = await verifyConfig('aadhaar');
  if (!cfg) return { ref: 'SANDBOX-' + a.slice(-4), message: 'OTP sent (sandbox — use 123456)', sandbox: true };
  const raw = await httpJson<Record<string, unknown>>(cfg.baseUrl!, {
    method: 'POST', headers: headers(cfg), body: { action: 'send_otp', aadhaar: a },
  });
  const ref = String(raw.ref ?? raw.request_id ?? raw.txn_id ?? raw.reference ?? '');
  return { ref, message: String(raw.message || 'OTP sent to the Aadhaar-linked mobile'), sandbox: false };
}

export interface OtpVerify { verified: boolean; name?: string; message: string; sandbox: boolean; }
export async function aadhaarVerifyOtp(aadhaar: string, ref: string, otp: string): Promise<OtpVerify> {
  const a = aadhaar.trim();
  if (!AADHAAR_RE.test(a)) return { verified: false, message: 'Invalid Aadhaar number', sandbox: false };
  const cfg = await verifyConfig('aadhaar');
  if (!cfg) {
    const ok = otp.trim() === '123456' && ref.startsWith('SANDBOX-');
    return { verified: ok, message: ok ? 'Aadhaar verified (sandbox)' : 'Invalid OTP (sandbox expects 123456)', sandbox: true };
  }
  const raw = await httpJson<Record<string, unknown>>(cfg.baseUrl!, {
    method: 'POST', headers: headers(cfg), body: { action: 'verify_otp', aadhaar: a, ref, otp },
  });
  const ok = isVerified(raw);
  return { verified: ok, name: (raw.name as string) || undefined, message: ok ? 'Aadhaar verified' : String(raw.message || 'Aadhaar not verified'), sandbox: false };
}
