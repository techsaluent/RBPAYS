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
async function verifyConfigKeys(keys: string[]): Promise<VerifyConfig | null> {
  // First active integration among the given keys wins (priority = list order).
  const order = keys.map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ');
  const { rows } = await query<{ base_url: string | null; api_key: string | null; api_secret: string | null }>(
    `SELECT base_url, api_key, api_secret FROM platform_integrations
      WHERE key = ANY($1) AND is_active = true
      ORDER BY CASE key ${order} ELSE 99 END LIMIT 1`,
    [keys],
  );
  const r = rows[0];
  if (!r?.base_url) return null;
  return { baseUrl: r.base_url, apiKey: r.api_key, apiSecret: r.api_secret };
}
async function verifyConfig(kind: 'pan' | 'aadhaar'): Promise<VerifyConfig | null> {
  // Accept both the short key and the API-Hub slot key (seeded as pan_nsdl /
  // aadhaar_kyc), then the shared 'verification' row — first active wins.
  return verifyConfigKeys(kind === 'pan'
    ? ['pan', 'pan_nsdl', 'verification']
    : ['aadhaar', 'aadhaar_kyc', 'verification']);
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

// ---- GSTIN (free): local structure + checksum, optional live lookup --------
// A GSTIN is 15 chars: 2-digit state + 10-char PAN + 1 entity code + 'Z' +
// 1 check digit. The check digit is a mod-36 weighted checksum over the first
// 14 chars — validating it rejects random junk for free, no API call.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// GST state codes (first two digits) → state/UT name.
const GST_STATE: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory', '99': 'Centre Jurisdiction',
};
/** Official GSTIN check-digit over the first 14 chars (mod-36 weighted). */
function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < first14.length; i++) {
    const cp = GSTIN_CHARSET.indexOf(first14[i]);
    const product = cp * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARSET[(36 - (sum % 36)) % 36];
}

export interface GstinResult {
  valid: boolean;
  gstin?: string;
  pan?: string;
  state_code?: string;
  state?: string;
  entity_code?: string;
  checksum_ok?: boolean;
  live?: boolean;
  legal_name?: string;
  trade_name?: string;
  status?: string;
  message: string;
}
/** Free, instant, offline structure + checksum validation. */
export function validateGstin(gstinRaw: string): GstinResult {
  const g = (gstinRaw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!GSTIN_RE.test(g)) return { valid: false, message: 'Invalid GSTIN structure (expected 15 characters)' };
  const stateCode = g.substring(0, 2);
  const state = GST_STATE[stateCode];
  if (!state) return { valid: false, state_code: stateCode, message: `Unknown GST state code "${stateCode}"` };
  const checksumOk = gstinCheckChar(g.substring(0, 14)) === g[14];
  return {
    valid: checksumOk,
    gstin: g,
    pan: g.substring(2, 12),
    state_code: stateCode,
    state,
    entity_code: g[12],
    checksum_ok: checksumOk,
    message: checksumOk ? `Structurally valid — ${state}` : 'Checksum failed — this GSTIN is not genuine',
  };
}
/**
 * Validate locally, then (only for a structurally-valid number, so no free
 * credit is wasted on junk) optionally fetch live status from a configured
 * GSTIN provider under API Hub (key 'gstin'/'gst', or shared 'verification').
 */
export async function verifyGstin(gstinRaw: string): Promise<GstinResult> {
  const local = validateGstin(gstinRaw);
  if (!local.valid) return local;
  const cfg = await verifyConfigKeys(['gstin', 'gst', 'verification']);
  if (!cfg) {
    return { ...local, live: false, message: local.message + ' · live status needs a GSTIN provider in API Hub' };
  }
  try {
    const raw = await httpJson<Record<string, unknown>>(cfg.baseUrl!, {
      method: 'POST', headers: headers(cfg), body: { gstin: local.gstin, gstno: local.gstin },
    });
    const data = (raw.data as Record<string, unknown>) || raw;
    return {
      ...local,
      live: true,
      legal_name: (data.legal_name ?? data.lgnm ?? data.name) as string | undefined,
      trade_name: (data.trade_name ?? data.tradeNam ?? data.tradeName) as string | undefined,
      status: (data.status ?? data.sts ?? data.gst_status) as string | undefined,
      message: 'GSTIN verified live',
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'GSTIN live lookup failed');
    return { ...local, live: false, message: local.message + ' · live lookup failed, showing structure only' };
  }
}
