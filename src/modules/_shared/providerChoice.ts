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
