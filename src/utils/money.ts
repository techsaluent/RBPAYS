/**
 * Money helpers. Internally everything is BIGINT paise (integer minor units).
 * Postgres BIGINT arrives as a JS string via node-pg, so we parse carefully.
 */

/** Convert a rupee amount (number or numeric string) to integer paise. */
export function rupeesToPaise(rupees: number | string): number {
  const n = typeof rupees === 'string' ? Number(rupees) : rupees;
  if (!Number.isFinite(n)) throw new Error('invalid amount');
  // Round to avoid 19.99 * 100 = 1998.9999...
  return Math.round(n * 100);
}

/** Convert integer paise to a fixed 2-decimal rupee string, e.g. "1234.50". */
export function paiseToRupees(paise: number | string): string {
  const p = typeof paise === 'string' ? Number(paise) : paise;
  return (p / 100).toFixed(2);
}

/** node-pg returns BIGINT as string; coerce safely to a JS number of paise. */
export function bigintToNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'string' ? Number(value) : value;
}
