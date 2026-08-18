import { NextFunction, Request, Response } from 'express';
import { query } from '../../db';
import { ApiError } from '../utils/ApiError';
import { permissionForPath } from '../modules/staff/permissions';

/** Load the permission set granted to a staff user. */
export async function getStaffPermissions(userId: string): Promise<string[]> {
  const { rows } = await query<{ permission: string }>(
    'SELECT permission FROM staff_permissions WHERE user_id = $1',
    [userId],
  );
  return rows.map((r) => r.permission);
}

/**
 * Gate the whole admin console. The super admin passes everything; a staff user
 * must hold the permission that governs the requested path (resolved centrally
 * from the path + method). Unknown paths fail closed. Any other role is denied.
 */
export async function staffConsoleGate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  if (req.user.role === 'admin') return next();
  if (req.user.role !== 'staff') throw ApiError.forbidden();

  const required = permissionForPath(req.path, req.method);
  if (required === null) return next(); // e.g. the read-only dashboard
  if (required === 'DENY') throw ApiError.forbidden('This section is restricted to the super admin');

  const held = await getStaffPermissions(req.user.id);
  // users.manage implies the ability to view users too.
  if (required === 'users.view' && held.includes('users.manage')) return next();
  if (!held.includes(required)) {
    throw ApiError.forbidden('You do not have permission for this action');
  }
  return next();
}

/**
 * Guard a single route by an explicit permission (used outside the admin
 * router, e.g. KYC review). Admin always passes; staff must hold `perm`.
 */
export function requirePermission(perm: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) throw ApiError.unauthorized();
    if (req.user.role === 'admin') return next();
    if (req.user.role !== 'staff') throw ApiError.forbidden();
    const held = await getStaffPermissions(req.user.id);
    if (!held.includes(perm)) throw ApiError.forbidden('You do not have permission for this action');
    return next();
  };
}
