import { NextFunction, Request, Response } from 'express';
import { query } from '../../db';
import { ApiError } from '../utils/ApiError';

/**
 * Services that any network role (retailer, distributor, master distributor)
 * may perform because they move the member's OWN wallet balance out to a bank
 * account — i.e. a self-service withdrawal / payout — rather than a
 * customer-facing transaction. Everything else is retailer-only.
 */
const NETWORK_SELF_SERVICE = new Set<string>(['payout', 'wallet_transfer']);

/**
 * Guard a service route: the account must be active, the service globally
 * enabled, and (if the member has a user_services row) that row must be active.
 * Members created via onboarding get explicit rows; plain signup users have
 * none and are allowed by default.
 */
export function requireService(serviceCode: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) throw ApiError.unauthorized();

      const { rows } = await query<{ status: string; enabled: boolean | null; active: boolean | null }>(
        `SELECT u.status,
                s.enabled,
                us.active
           FROM users u
           LEFT JOIN services s ON s.code = $2
           LEFT JOIN user_services us ON us.user_id = u.id AND us.service_code = $2
          WHERE u.id = $1`,
        [req.user.id, serviceCode],
      );
      // Only retailers (and plain users / admin for support) perform customer
      // transactions; distributors and master distributors manage their network.
      // Exception: wallet-to-bank payout / wallet transfer is a self-service
      // withdrawal every network role may perform on their own balance.
      if (
        (req.user.role === 'distributor' || req.user.role === 'master_distributor') &&
        !NETWORK_SELF_SERVICE.has(serviceCode)
      ) {
        throw ApiError.forbidden('Only retailers can perform customer transactions');
      }

      const row = rows[0];
      if (!row) throw ApiError.unauthorized();
      if (row.status !== 'active') throw ApiError.forbidden(`Account is ${row.status}`);
      if (row.enabled === false) throw ApiError.forbidden(`Service ${serviceCode} is disabled`);
      if (row.active === false) throw ApiError.forbidden(`Service ${serviceCode} is not active for your account`);
      next();
    } catch (err) {
      next(err);
    }
  };
}
