import { httpJson, HttpError } from './http';
import { activeConfig, ActiveProvider } from './registry';
import {
  BbpsPayInput,
  BbpsProvider,
  DmtProvider,
  DmtTransferInput,
  GenericServiceInput,
  GenericServiceProvider,
  PayoutInput,
  PayoutProvider,
  ProviderResult,
  RechargeInput,
  RechargeProvider,
} from './types';

/**
 * Config-driven provider. The whole integration lives in the provider row's
 * `extra` JSON — no code. This is what lets a new aggregator be added, tested
 * and activated without a developer or a deploy.
 *
 * extra = {
 *   "base_url": "https://…",            // optional (else provider.base_url)
 *   "amount": "rupees" | "paise",       // how to send the amount (default rupees)
 *   "auth": {                            // request auth
 *     "type": "headers" | "bearer",
 *     "headers": { "client-id": "{api_key}", "client-secret": "{api_secret}" }
 *   },
 *   "services": {
 *     "payout": {
 *       "path": "/payout/transfer", "method": "POST",
 *       "request": { "client_referenceId":"{reference}", "amount":"{amount}",
 *                    "accountNumber":"{account_number}", "ifsc":"{ifsc}",
 *                    "beneficiaryName":"{beneficiary_name}", "mode":"{mode}" },
 *       "status_field": "status",
 *       "success": ["SUCCESS","success","0"],
 *       "failed":  ["FAILED","REJECTED"],
 *       "ref_field": "data.transactionId", "utr_field": "data.utr",
 *       "message_field": "message"
 *     }
 *   }
 * }
 * Placeholders: {reference} {amount} {amount_paise} {account_number} {ifsc}
 * {beneficiary_name} {mode} {operator} {number} {recharge_type} {circle}
 * {biller_id} {consumer_number} {category} {vpa}, plus credential placeholders
 * {api_key} {api_secret} {auth_token} {partner_id} and {extra.<key>}.
 */
export interface DynamicServiceCfg {
  path?: string;
  method?: string;
  request?: Record<string, unknown>;
  status_field?: string;
  success?: string[];
  failed?: string[];
  ref_field?: string;
  utr_field?: string;
  rrn_field?: string;
  message_field?: string;
}
export interface DynamicCfg {
  base_url?: string;
  amount?: 'rupees' | 'paise';
  auth?: { type?: string; headers?: Record<string, string> };
  services?: Record<string, DynamicServiceCfg>;
}

/** Read a dot-path (e.g. "data.transactionId") from a nested object. */
function dot(obj: unknown, path?: string): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Replace {placeholder} tokens inside a string from the vars map. */
function fill(s: string, vars: Record<string, string>): string {
  return s.replace(/\{([a-z0-9_.]+)\}/gi, (_m, k) => (vars[k] !== undefined ? vars[k] : ''));
}

/** Deep-resolve every string in a template object/array against vars. */
function resolve(tpl: unknown, vars: Record<string, string>): unknown {
  if (typeof tpl === 'string') return fill(tpl, vars);
  if (Array.isArray(tpl)) return tpl.map((v) => resolve(v, vars));
  if (tpl && typeof tpl === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tpl)) out[k] = resolve(v, vars);
    return out;
  }
  return tpl;
}

/** The credential subset a dynamic call needs (ActiveProvider satisfies it). */
export interface DynCred {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  authToken: string;
  partnerId: string;
  extra: Record<string, unknown>;
}

/** Credential + extra placeholders available to every template. */
function credVars(c: DynCred): Record<string, string> {
  const v: Record<string, string> = {
    api_key: c.apiKey, api_secret: c.apiSecret, auth_token: c.authToken, partner_id: c.partnerId,
  };
  for (const [k, val] of Object.entries(c.extra || {})) {
    if (typeof val === 'string' || typeof val === 'number') v[`extra.${k}`] = String(val);
  }
  return v;
}

function buildHeaders(cfg: DynamicCfg, c: DynCred, vars: Record<string, string>): Record<string, string> {
  const auth = cfg.auth || {};
  if (auth.type === 'bearer') return { Authorization: `Bearer ${c.authToken || c.apiKey}` };
  const h: Record<string, string> = {};
  for (const [k, tpl] of Object.entries(auth.headers || {})) h[k] = fill(String(tpl), vars);
  return h;
}

function mapStatus(cfg: DynamicServiceCfg, raw: unknown): ProviderResult['status'] {
  const val = String(dot(raw, cfg.status_field) ?? '').toLowerCase().trim();
  const inList = (list?: string[]) => (list || []).some((s) => String(s).toLowerCase() === val);
  if (inList(cfg.success)) return 'success';
  if (inList(cfg.failed)) return 'failed';
  return 'pending';
}

/** Core: execute one dynamic call against a provider (used live and in tests). */
async function execDynamic(c: DynCred, service: string, extraVars: Record<string, string>): Promise<ProviderResult> {
  const cfg = (c.extra || {}) as DynamicCfg;
  const svc = cfg.services?.[service];
  if (!svc || !svc.path) return { status: 'failed', message: `dynamic config missing for ${service}` };

  const vars = { ...credVars(c), ...extraVars };
  const base = (cfg.base_url || c.baseUrl || '').replace(/\/+$/, '');
  const url = base + fill(svc.path, vars);
  const body = resolve(svc.request ?? {}, vars);
  try {
    const raw = await httpJson(url, { method: (svc.method as 'POST') || 'POST', headers: buildHeaders(cfg, c, vars), body });
    return {
      status: mapStatus(svc, raw),
      providerRef: (dot(raw, svc.ref_field) as string) || undefined,
      utr: (dot(raw, svc.utr_field) as string) || undefined,
      rrn: (dot(raw, svc.rrn_field) as string) || undefined,
      message: (dot(raw, svc.message_field) as string) || undefined,
      raw,
    };
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.body && typeof err.body === 'object') {
        return {
          status: mapStatus(svc, err.body),
          message: (dot(err.body, svc.message_field) as string) || `HTTP ${err.status}`,
          raw: err.body,
        };
      }
      return { status: 'failed', message: `HTTP ${err.status}`, raw: err.body };
    }
    return { status: 'pending', message: (err as Error).message };
  }
}

async function run(service: string, extraVars: Record<string, string>, providerId?: string): Promise<ProviderResult> {
  const c = activeConfig(service, providerId);
  if (!c) return { status: 'pending', message: 'dynamic provider not active' };
  return execDynamic(c, service, extraVars);
}

/**
 * Live self-test: run the config against the provider for real (test data) and
 * return the mapped result — so an admin can confirm a new integration works
 * before activating it, without creating a wallet transaction.
 */
export function liveTestDynamic(c: DynCred, service: string, sample: Record<string, string>): Promise<ProviderResult> {
  return execDynamic(c, service, sample);
}

/** Amount string per the provider's `amount` unit (default rupees). */
function amountVars(c: ActiveProvider | undefined, paise: number): Record<string, string> {
  const unit = (c?.extra as DynamicCfg)?.amount;
  return { amount: unit === 'paise' ? String(paise) : (paise / 100).toFixed(2), amount_paise: String(paise) };
}

export const dynamicDmt: DmtProvider = {
  name: 'dynamic',
  transfer(i: DmtTransferInput): Promise<ProviderResult> {
    return run('dmt', {
      reference: i.reference, ...amountVars(activeConfig('dmt', i.providerId), i.amountPaise),
      account_number: i.accountNumber, ifsc: i.ifsc, beneficiary_name: i.beneficiaryName, mode: i.mode,
    }, i.providerId);
  },
};
export const dynamicPayout: PayoutProvider = {
  name: 'dynamic',
  payout(i: PayoutInput): Promise<ProviderResult> {
    return run('payout', {
      reference: i.reference, ...amountVars(activeConfig('payout', i.providerId), i.amountPaise),
      account_number: i.accountNumber, ifsc: i.ifsc, beneficiary_name: i.beneficiaryName, mode: i.mode,
    }, i.providerId);
  },
};
export const dynamicRecharge: RechargeProvider = {
  name: 'dynamic',
  recharge(i: RechargeInput): Promise<ProviderResult> {
    return run('recharge', {
      reference: i.reference, ...amountVars(activeConfig('recharge', i.providerId), i.amountPaise),
      operator: i.operator, number: i.number, recharge_type: i.rechargeType, circle: i.circle ?? '',
    }, i.providerId);
  },
};
export const dynamicBbps: BbpsProvider = {
  name: 'dynamic',
  pay(i: BbpsPayInput): Promise<ProviderResult> {
    return run('bbps', {
      reference: i.reference, ...amountVars(activeConfig('bbps', i.providerId), i.amountPaise),
      biller_id: i.billerId, consumer_number: i.consumerNumber, category: i.category ?? '',
    }, i.providerId);
  },
};
export const dynamicGeneric: GenericServiceProvider = {
  name: 'dynamic',
  execute(service: string, i: GenericServiceInput): Promise<ProviderResult> {
    const meta: Record<string, string> = {};
    for (const [k, v] of Object.entries(i.meta ?? {})) meta[k] = String(v);
    return run(service, { reference: i.reference, ...amountVars(activeConfig(service, i.providerId), i.amountPaise), ...meta }, i.providerId);
  },
};

/**
 * Dry-run a dynamic config for self-testing: resolve the request the platform
 * WOULD send (secrets masked) without calling the provider — so an admin (or
 * the AI assistant) can validate the mapping before activating. Returns the
 * URL, headers and body, plus any config problems.
 */
export function dryRunDynamic(
  c: DynCred,
  service: string,
  sample: Record<string, string>,
): { ok: boolean; problems: string[]; url?: string; method?: string; headers?: Record<string, string>; body?: unknown } {
  const cfg = (c.extra || {}) as DynamicCfg;
  const problems: string[] = [];
  const svc = cfg.services?.[service];
  if (!svc) { problems.push(`No "services.${service}" block in config.`); return { ok: false, problems }; }
  if (!svc.path) problems.push('Missing "path".');
  if (!svc.request) problems.push('Missing "request" field map.');
  if (!svc.status_field) problems.push('Missing "status_field" (where to read the provider status).');
  if (!svc.success?.length) problems.push('Missing "success" status values.');
  const vars = { ...credVars(c), ...sample };
  const base = (cfg.base_url || c.baseUrl || '').replace(/\/+$/, '');
  const mask = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v && v.length > 6 ? v.slice(0, 3) + '••••' : '••••']));
  return {
    ok: problems.length === 0,
    problems,
    url: base + fill(svc.path || '', vars),
    method: svc.method || 'POST',
    headers: mask(buildHeaders(cfg, c, vars)),
    body: resolve(svc.request ?? {}, vars),
  };
}
