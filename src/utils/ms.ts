/**
 * Tiny duration parser: "15m" -> 900000, "30d" -> 2592000000.
 * Supports s, m, h, d. A plain number is treated as milliseconds.
 */
const UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export default function ms(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error(`invalid duration: ${value}`);
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  return unit ? amount * UNITS[unit] : amount;
}
