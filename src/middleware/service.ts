import { NextFunction, Request, Response } from 'express';
import { query } from '../../db';
import { ApiError } from '../utils/ApiError';

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
