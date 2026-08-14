import { randomUUID } from 'crypto';

/**
 * Generate a human-friendly internal reference for a service transaction,
 * e.g. RB-DMT-8F3A1C2B. Callers may also pass their own idempotency ref.
 */
export function makeReference(prefix: string): string {
  const rand = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
  return `RB-${prefix.toUpperCase()}-${rand}`;
}
