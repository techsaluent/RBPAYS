import { listActiveProviders } from '../../providers/registry';
import { ApiError } from '../../utils/ApiError';

/**
 * Validate an optional caller-chosen provider for a service. Returns the id to
 * use (or undefined to let the platform pick the default active provider).
 * Rejects a provider that isn't live for this service so a stale choice can't
 * silently route to the wrong rail.
 */
export function resolveProviderChoice(service: string, providerId?: string): string | undefined {
  if (!providerId) return undefined;
  const ok = listActiveProviders(service).some((p) => p.id === providerId);
  if (!ok) throw ApiError.badRequest('The selected provider is not available for this service');
  return providerId;
}

/**
 * Ordered failover candidates for a service: the chosen provider first (when
 * given), then the remaining active providers by priority. Returns 1 entry when
 * there is 0/1 active provider (i.e. no failover happens unless the admin has
 * activated 2+ providers for the service). The orchestrator advances to the
 * next candidate only on a hard `failed`.
 */
export function failoverCandidates(
  service: string,
  chosenId?: string,
): Array<{ id: string | undefined; name: string }> {
  const active = listActiveProviders(service);
  if (active.length === 0) return [{ id: chosenId, name: service }]; // env-default single call
  const ordered = chosenId
    ? [...active.filter((p) => p.id === chosenId), ...active.filter((p) => p.id !== chosenId)]
    : active;
  return ordered.map((p) => ({ id: p.id, name: p.label }));
}
