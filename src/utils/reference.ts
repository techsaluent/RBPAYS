import { randomBytes } from 'crypto';

// Uppercase letters + digits (36 symbols). No prefix, no separators.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const REFERENCE_LENGTH = 15;

/**
 * Generate a platform transaction reference: a unique 15-character code of
 * uppercase letters and digits, e.g. "A3F9K2M8QP1XZ7B". This is our own
 * transaction id (randomly generated per txn); the bank UTR is separate and
 * comes back from the provider's API / callback.
 *
 * 36^15 ≈ 2.2e23 possibilities, and the DB enforces a UNIQUE constraint on the
 * reference, so collisions are effectively impossible. The optional argument is
 * ignored (kept so existing callers don't need to change).
 */
export function makeReference(_prefix?: string): string {
  const bytes = randomBytes(REFERENCE_LENGTH);
  let out = '';
  for (let i = 0; i < REFERENCE_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
