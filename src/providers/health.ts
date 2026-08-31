import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Provider go-live connectivity probe.
 *
 * Verifying a live provider before routing real money to it: checks that the
 * config is complete for the driver and that the endpoint is reachable over the
 * network (DNS + TLS + an HTTP response — any status, even 401/404, proves the
 * path and that our request left the building). It deliberately does NOT run a
 * real transaction; it is a pre-flight reachability + config check.
 */
export interface ProviderRow {
  id: string;
  service_code: string;
  label: string;
  driver: string;
  base_url: string | null;
  api_key: string | null;
  api_secret: string | null;
  auth_token: string | null;
  partner_id: string | null;
  is_active: boolean;
}

export interface ProbeCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ProbeResult {
  ok: boolean;
  mode: 'sandbox' | 'live';
  reachable: boolean | null; // null when no network probe was applicable
  http_status?: number;
  checks: ProbeCheck[];
  message: string;
}

export async function probeProvider(p: ProviderRow): Promise<ProbeResult> {
  const checks: ProbeCheck[] = [];

  if (p.driver === 'sandbox') {
    return {
      ok: true,
      mode: 'sandbox',
      reachable: null,
      checks: [{ label: 'Sandbox driver', ok: true, detail: 'Simulated provider — always available, no live endpoint.' }],
      message: 'Sandbox driver is ready. Switch to a live driver and add real credentials to go live.',
    };
  }

  // Config completeness — credentials most live drivers need.
  const hasUrl = !!p.base_url && /^https?:\/\//i.test(p.base_url);
  checks.push({ label: 'Base URL set', ok: hasUrl, detail: hasUrl ? p.base_url! : 'Missing or not an http(s) URL' });
  const hasCred = !!(p.api_key || p.auth_token || p.api_secret);
  checks.push({ label: 'Credentials set', ok: hasCred, detail: hasCred ? 'API key / token present' : 'No API key, secret or token configured' });

  // Network reachability — only if we have a URL to hit.
  let reachable: boolean | null = null;
  let httpStatus: number | undefined;
  if (hasUrl) {
    const probe = await reach(p.base_url!);
    reachable = probe.reachable;
    httpStatus = probe.status;
    checks.push({
      label: 'Endpoint reachable',
      ok: probe.reachable,
      detail: probe.reachable ? `Responded (HTTP ${probe.status})` : probe.error || 'No response',
    });
  }

  const ok = checks.every((c) => c.ok);
  const message = ok
    ? 'Provider looks ready: config complete and endpoint reachable. This is a connectivity check, not a live transaction.'
    : 'Not ready — see the failing checks below.';
  return { ok, mode: 'live', reachable, http_status: httpStatus, checks, message };
}

/** Hit a URL and treat ANY HTTP response as reachable; only network/DNS/TLS/timeout is a failure. */
async function reach(url: string): Promise<{ reachable: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(env.HTTP_TIMEOUT_MS, 8000));
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return { reachable: true, status: res.status };
  } catch (err) {
    const msg = (err as Error).name === 'AbortError' ? 'Timed out' : (err as Error).message;
    logger.info({ url, err: msg }, 'provider reachability probe failed');
    return { reachable: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
