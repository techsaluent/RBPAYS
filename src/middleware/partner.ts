import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';

/**
 * Gate the public partner (reseller) API. Runs AFTER requireAuth, which resolves
 * a `pk_` key into req.partner. It:
 *   - rejects non-partner credentials (a JWT or staff key on this surface),
 *   - enforces the key's IP allowlist (empty list = any IP),
 *   - enforces a simple per-key, per-minute rate limit.
 */

// In-memory fixed-window counters, keyed by partner key id. Adequate for a
// single node; swap for Redis when the API runs multi-instance.
const windows = new Map<string, { count: number; resetAt: number }>();

/** Best-effort caller IP: first X-Forwarded-For hop, else the socket address. */
function callerIp(req: Request): string {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || req.socket.remoteAddress || '';
}

export function partnerGate(req: Request, res: Response, next: NextFunction): void {
  const p = req.partner;
  if (!p) {
    throw ApiError.unauthorized('This endpoint requires a partner API key (Bearer pk_...)');
  }

  // IP allowlist (opt-in per key).
  if (p.allowedIps.length > 0) {
    const ip = callerIp(req).replace(/^::ffff:/, ''); // unwrap IPv4-mapped IPv6
    const ok = p.allowedIps.some((a) => a.trim() === ip);
    if (!ok) throw ApiError.forbidden(`Caller IP ${ip} is not in this key's allowlist`);
  }

  // Fixed-window per-minute rate limit.
  const now = Date.now();
  const w = windows.get(p.keyId);
  if (!w || now >= w.resetAt) {
    windows.set(p.keyId, { count: 1, resetAt: now + 60_000 });
  } else {
    w.count += 1;
    if (w.count > p.rateLimitPerMin) {
      const retry = Math.ceil((w.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      throw new ApiError(429, 'rate_limited', `Rate limit exceeded (${p.rateLimitPerMin}/min)`);
    }
  }

  next();
}

/**
 * Require the resolved partner key to carry a scope for `serviceCode`. A key
 * with the wildcard scope `*` may call every service. Mount before a service
 * sub-router: partnerRouter.use('/recharge', partnerScope('recharge'), rechargeRouter).
 */
export function partnerScope(serviceCode: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const scopes = req.partner?.scopes ?? [];
    if (scopes.includes('*') || scopes.includes(serviceCode)) return next();
    throw ApiError.forbidden(`This API key is not scoped for '${serviceCode}'`);
  };
}
