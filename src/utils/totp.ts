import crypto from 'crypto';

/**
 * RFC 6238 TOTP (time-based one-time password) + RFC 4648 base32, implemented
 * on Node's crypto alone so authenticator-app 2FA needs no extra dependency.
 * Compatible with Google Authenticator, Authy, 1Password, etc. (SHA-1, 6
 * digits, 30-second step — the near-universal defaults).
 */
const STEP = 30;
const DIGITS = 6;
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Generate a random base32 TOTP secret (default 20 bytes → 32 chars). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

/** otpauth:// URI an authenticator app scans as a QR code. */
export function otpauthUri(secret: string, account: string, issuer = 'TutiPays'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The TOTP code for a given secret at a point in time (defaults to now). */
export function totpCode(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP);
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Verify a user-supplied code, tolerating ±`window` steps of clock drift.
 * Uses timing-safe comparison. Returns false for malformed secrets/codes.
 */
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const t = (token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t) || !secret) return false;
  const now = Date.now();
  for (let i = -window; i <= window; i++) {
    const candidate = totpCode(secret, now + i * STEP * 1000);
    if (timingSafeEqualStr(candidate, t)) return true;
  }
  return false;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- base32 (RFC 4648, no padding on encode; tolerant on decode) -----------
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
