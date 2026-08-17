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
  driver: 'sandbox' | 'aggregator' | 'razorpay' | 'generic';
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  authToken: string;
  partnerId: string;
  extra: Record<string, unknown>;
}

const active = new Map<string, ActiveProvider>();
let loaded = false;

export async function refreshProviderRegistry(): Promise<void> {
  try {
    const { rows } = await query<{
      service_code: string;
      driver: ActiveProvider['driver'];
      base_url: string | null;
      api_key: string | null;
      api_secret: string | null;
      auth_token: string | null;
      partner_id: string | null;
      extra: Record<string, unknown> | null;
    }>(
      `SELECT service_code, driver, base_url, api_key, api_secret, auth_token, partner_id, extra
         FROM service_providers
        WHERE is_active = true`,
    );
    active.clear();
    for (const r of rows) {
      active.set(r.service_code, {
        driver: r.driver,
        baseUrl: r.base_url ?? '',
        apiKey: r.api_key ?? '',
        apiSecret: r.api_secret ?? '',
        authToken: r.auth_token ?? '',
        partnerId: r.partner_id ?? '',
        extra: r.extra ?? {},
      });
    }
    loaded = true;
    logger.info({ services: [...active.keys()] }, 'provider registry refreshed');
  } catch (err) {
    // Table may not exist yet (before migration) — degrade to env defaults.
    logger.warn({ err: (err as Error).message }, 'provider registry not loaded; using env defaults');
  }
}

/** Active driver name for a service, or undefined to fall back to env. */
export function activeDriver(serviceCode: string): ActiveProvider['driver'] | undefined {
  return active.get(serviceCode)?.driver;
}

/** Active provider config (credentials) for a service, or undefined. */
export function activeConfig(serviceCode: string): ActiveProvider | undefined {
  return active.get(serviceCode);
}

export function registryLoaded(): boolean {
  return loaded;
}
