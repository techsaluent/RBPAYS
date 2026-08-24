import { randomUUID } from 'crypto';

/**
 * Generate a human-friendly platform reference (our own transaction id) for a
 * service transaction, e.g. TP-DMT-8F3A1C2B. Randomly generated per txn;
 * callers may also pass their own idempotency ref. The bank UTR is separate —
 * it comes back from the provider's API / callback, not from here.
 */
export function makeReference(prefix: string): string {
  const rand = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
  return `TP-${prefix.toUpperCase()}-${rand}`;
}
