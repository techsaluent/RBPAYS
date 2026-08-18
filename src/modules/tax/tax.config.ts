import { query } from '../../../db';
import { logger } from '../../config/logger';
import { env } from '../../config/env';

/**
 * Cached, super-admin-editable tax rates + caps (from the `tax_config` table).
 * Loaded at startup and refreshed whenever admin saves. Falls back to the env
 * defaults if the table has not been loaded yet.
 */
export interface TaxRate {
  rateBps: number;
  maxAmountPaise: number; // 0 = no cap
  enabled: boolean;
}

const DEFAULTS: Record<string, TaxRate> = {
  tds_194h_std: { rateBps: 500, maxAmountPaise: 0, enabled: true },
  tds_194h_high: { rateBps: 2000, maxAmountPaise: 0, enabled: true },
  tds_194n: { rateBps: env.TDS_194N_RATE_BPS, maxAmountPaise: 0, enabled: true },
  gst: { rateBps: 1800, maxAmountPaise: 0, enabled: true },
};

const cache = new Map<string, TaxRate>();

export async function refreshTaxConfig(): Promise<void> {
  try {
    const { rows } = await query<{ code: string; rate_bps: number; max_amount_paise: string; enabled: boolean }>(
      'SELECT code, rate_bps, max_amount_paise, enabled FROM tax_config',
    );
    cache.clear();
    for (const r of rows) {
      cache.set(r.code, { rateBps: r.rate_bps, maxAmountPaise: Number(r.max_amount_paise), enabled: r.enabled });
    }
    logger.info({ codes: [...cache.keys()] }, 'tax config refreshed');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'tax config not loaded; using defaults');
  }
}

export function taxRate(code: string): TaxRate {
  return cache.get(code) ?? DEFAULTS[code] ?? { rateBps: 0, maxAmountPaise: 0, enabled: false };
}

/** Compute a tax amount honouring the configured rate, cap and enabled flag. */
export function computeTax(code: string, basePaise: number): number {
  const r = taxRate(code);
  if (!r.enabled || r.rateBps <= 0 || basePaise <= 0) return 0;
  let tax = Math.round((basePaise * r.rateBps) / 10000);
  if (r.maxAmountPaise > 0) tax = Math.min(tax, r.maxAmountPaise);
  return tax;
}
