import crypto from 'crypto';
import { logger } from '../config/logger';

/**
 * Field-level encryption for secrets at rest (provider API secrets, SMTP
 * passwords, bot tokens, auth tokens). AES-256-GCM with a random 96-bit IV and
 * a 128-bit auth tag, wrapped in a versioned, self-describing envelope:
 *
 *     enc:v1:<base64( iv(12) || tag(16) || ciphertext )>
 *
 * Design goals:
 *  - Backward compatible. A value that is NOT the envelope is returned as-is, so
 *    existing plaintext rows keep working and encryption can be rolled out
 *    gradually (write encrypts, read decrypts-or-passes-through).
 *  - Fail safe for payments. When no key is configured, encrypt() passes the
 *    plaintext through unchanged — nothing breaks; secrets simply stay as they
 *    were until a key is set and the re-encrypt migration is run.
 *
 * Key: set exactly one of
 *   DATA_ENC_KEY    — 32 bytes as 64 hex chars or base64 (preferred), or
 *   DATA_ENC_SECRET — a passphrase; a 32-byte key is derived via scrypt.
 * Keep the key OUT of the repo (environment / secrets manager only). Losing the
 * key makes encrypted secrets unrecoverable, so back it up securely.
 */
const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;

let keyCache: Buffer | null | undefined;

function loadKey(): Buffer | null {
  if (keyCache !== undefined) return keyCache;
  const raw = (process.env.DATA_ENC_KEY || '').trim();
  const pass = (process.env.DATA_ENC_SECRET || '').trim();
  if (raw) {
    try {
      const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
      if (buf.length === 32) { keyCache = buf; return keyCache; }
      logger.error('DATA_ENC_KEY must decode to 32 bytes (64 hex chars or base64) — secrets stay plaintext');
    } catch {
      logger.error('DATA_ENC_KEY is not valid hex/base64 — secrets stay plaintext');
    }
  }
  if (pass) {
    keyCache = crypto.scryptSync(pass, 'rbpays-secrets-at-rest-v1', 32);
    return keyCache;
  }
  keyCache = null;
  return keyCache;
}

/** Whether a valid encryption key is configured (encryption actually happens). */
export function encryptionEnabled(): boolean {
  return loadKey() !== null;
}

/** True if a stored value is in the encrypted envelope format. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a secret for storage. Returns the envelope string, or — when no key
 * is configured, or the input is empty/already encrypted — the input unchanged.
 */
export function encryptSecret<T extends string | null | undefined>(plain: T): T | string {
  if (plain == null || plain === '') return plain;
  if (isEncrypted(plain)) return plain;
  const key = loadKey();
  if (!key) return plain; // passthrough — nothing breaks without a key
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt a stored secret. A non-envelope value (legacy plaintext) is returned
 * unchanged. A decryption failure returns null and is logged — never throws, so
 * a bad row can't crash a request path.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!isEncrypted(stored)) return stored;
  const key = loadKey();
  if (!key) {
    logger.error('an encrypted secret was read but no DATA_ENC_KEY is configured');
    return null;
  }
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'secret decryption failed (wrong key or tampered data)');
    return null;
  }
}

/** For test/diagnostics: reset the cached key so a new env value is picked up. */
export function _resetKeyCache(): void {
  keyCache = undefined;
}
