import { httpJson } from './http';

/**
 * Uniform "master wallet" balance fetch for any provider connection.
 *
 * Providers expose their own balance endpoint; rather than a bespoke call per
 * driver, a connection declares how to read it in its `extra.balance` config:
 *   { path | url, method?, headers?, body?, amount_field?, paise? }
 * - path    : appended to the connection base_url (or give an absolute `url`)
 * - method  : GET (default) | POST
 * - amount_field : dot-path to the balance in the JSON response (default "balance")
 * - paise   : true if the value is already in paise (default false → rupees)
 * Sandbox returns a synthetic balance so the flow is demoable. When no balance
 * config is present, it reports unsupported with the exact config to add.
 */
export interface ProviderBalanceRow {
  driver: string;
  base_url: string | null;
  api_key: string | null;
  api_secret: string | null;
  auth_token: string | null;
  extra: Record<string, unknown> | null;
}

export interface BalanceResult {
  supported: boolean;
  balance_paise?: number;
  message?: string;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

export async function fetchProviderBalance(row: ProviderBalanceRow): Promise<BalanceResult> {
  if (row.driver === 'sandbox') {
    return { supported: true, balance_paise: 10_000_000, message: 'Sandbox master balance (simulated).' };
  }
  const extra = row.extra ?? {};
  const bc = (extra.balance as Record<string, unknown>) || null;
  if (!bc || !(bc.url || bc.path)) {
    return {
      supported: false,
      message: 'Balance check not set up for this provider. Add to Advanced config, e.g. {"balance":{"path":"/balance","method":"POST","amount_field":"data.balance"}} — ask your provider for the balance endpoint + the field that holds the amount.',
    };
  }
  const base = (row.base_url || '').replace(/\/+$/, '');
  const url = String(bc.url || base + String(bc.path));
  const headers: Record<string, string> = {
    ...(row.api_key ? { Authorization: `Bearer ${row.api_key}`, 'X-Api-Key': row.api_key, 'client-id': row.api_key } : {}),
    ...(row.api_secret ? { 'X-Api-Secret': row.api_secret, 'client-secret': row.api_secret } : {}),
    ...((bc.headers as Record<string, string>) || {}),
  };
  try {
    const raw = await httpJson<Record<string, unknown>>(url, {
      method: (String(bc.method || 'GET').toUpperCase() as 'GET' | 'POST'),
      headers,
      body: (bc.body as Record<string, unknown>) || undefined,
    });
    const field = String(bc.amount_field || 'balance');
    const v = getPath(raw, field);
    if (v == null) return { supported: true, message: `Called OK but no "${field}" in the response.` };
    const num = Number(v);
    if (!Number.isFinite(num)) return { supported: true, message: `Balance field "${field}" is not a number.` };
    const paise = bc.paise === true ? Math.round(num) : Math.round(num * 100);
    return { supported: true, balance_paise: paise };
  } catch (err) {
    return { supported: false, message: (err as Error).message };
  }
}
