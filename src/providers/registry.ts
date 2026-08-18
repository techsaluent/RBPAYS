import { query } from '../../db';
import { logger } from '../config/logger';

/**
 * Active-provider registry.
 *
 * Super admin registers one or more providers per service in the
 * `service_providers` table and marks one active. This module keeps an
 * in-memory snapshot of the active provider (driver + credentials) per
 * service so the synchronous provider getters can route to it without a
 * DB round-trip on every transaction. The snapshot is loaded at startup
 * and refreshed whenever admin changes a provider.
 *
 * When no active row exists for a service, callers fall back to the
 * env-configured driver — so the API still runs out of the box.
 */
export interface ActiveProvider {
  id: string;
  label: string;
  priority: number;
  driver: 'sandbox' | 'aggregator' | 'razorpay' | 'generic';
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  authToken: string;
  partnerId: string;
  extra: Record<string, unknown>;
}

// All active providers per service (highest priority first) + a by-id index so
// a caller can route to a specific chosen provider.
const activeByService = new Map<string, ActiveProvider[]>();
const activeById = new Map<string, ActiveProvider>();
let loaded = false;

export async function refreshProviderRegistry(): Promise<void> {
  try {
    const { rows } = await query<{
      id: string;
      label: string | null;
      priority: number | null;
      service_code: string;
      driver: ActiveProvider['driver'];
      base_url: string | null;
      api_key: string | null;
      api_secret: string | null;
      auth_token: string | null;
      partner_id: string | null;
      extra: Record<string, unknown> | null;
    }>(
      `SELECT id, label, priority, service_code, driver, base_url, api_key, api_secret, auth_token, partner_id, extra
         FROM service_providers
        WHERE is_active = true
        ORDER BY service_code, priority DESC, created_at`,
    );
    activeByService.clear();
    activeById.clear();
    for (const r of rows) {
      const p: ActiveProvider = {
        id: r.id,
        label: r.label ?? r.service_code,
        priority: r.priority ?? 0,
        driver: r.driver,
        baseUrl: r.base_url ?? '',
        apiKey: r.api_key ?? '',
        apiSecret: r.api_secret ?? '',
        authToken: r.auth_token ?? '',
        partnerId: r.partner_id ?? '',
        extra: r.extra ?? {},
      };
      (activeByService.get(r.service_code) ?? activeByService.set(r.service_code, []).get(r.service_code)!).push(p);
      activeById.set(r.id, p);
    }
    loaded = true;
    logger.info({ services: [...activeByService.keys()] }, 'provider registry refreshed');
  } catch (err) {
    // Table may not exist yet (before migration) — degrade to env defaults.
    logger.warn({ err: (err as Error).message }, 'provider registry not loaded; using env defaults');
  }
}

/**
 * Resolve the provider to use for a service. When `providerId` is given and it
 * is an active provider for that service, it wins; otherwise the highest
 * priority active provider is used. Undefined => caller falls back to env.
 */
export function resolveProvider(serviceCode: string, providerId?: string): ActiveProvider | undefined {
  if (providerId) {
    const p = activeById.get(providerId);
    if (p && (serviceCode ? providerBelongs(serviceCode, providerId) : true)) return p;
  }
  return activeByService.get(serviceCode)?.[0];
}

function providerBelongs(serviceCode: string, providerId: string): boolean {
  return (activeByService.get(serviceCode) ?? []).some((p) => p.id === providerId);
}

/** Active driver name for a service (optionally a specific provider). */
export function activeDriver(serviceCode: string, providerId?: string): ActiveProvider['driver'] | undefined {
  return resolveProvider(serviceCode, providerId)?.driver;
}

/** Active provider config (credentials) for a service (optionally specific). */
export function activeConfig(serviceCode: string, providerId?: string): ActiveProvider | undefined {
  return resolveProvider(serviceCode, providerId);
}

/** List active providers for a service (for the retailer's provider chooser). */
export function listActiveProviders(serviceCode: string): Array<{ id: string; label: string; driver: string }> {
  return (activeByService.get(serviceCode) ?? []).map((p) => ({ id: p.id, label: p.label, driver: p.driver }));
}

export function registryLoaded(): boolean {
  return loaded;
}
