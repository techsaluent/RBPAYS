/**
 * Admin console permission catalog.
 *
 * The super admin ('admin' role) implicitly holds every permission. A 'staff'
 * user holds exactly the permissions granted in staff_permissions. Each admin
 * console section maps to one permission; the staffConsoleGate resolves the
 * required permission from the request path and enforces it centrally.
 */
export interface PermissionDef {
  key: string;
  label: string;
  group: string;
}

export const PERMISSIONS: PermissionDef[] = [
  { key: 'kyc.review', label: 'KYC review (approve / reject)', group: 'Onboarding' },
  { key: 'users.view', label: 'View users', group: 'Users' },
  { key: 'users.manage', label: 'Manage users (suspend, edit, reset password)', group: 'Users' },
  { key: 'topup.manage', label: 'Top-up approvals & company bank accounts', group: 'Finance' },
  { key: 'recon.manage', label: 'Reconciliation & adjustments', group: 'Finance' },
  { key: 'payouts.manage', label: 'Batch payouts & treasury', group: 'Finance' },
  { key: 'tax.manage', label: 'Tax (TDS / GST) desk', group: 'Finance' },
  { key: 'commission.manage', label: 'Commission plans', group: 'Config' },
  { key: 'providers.manage', label: 'Services & providers (API keys)', group: 'Config' },
  { key: 'integrations.manage', label: 'Integrations (SMS / email / OTP / KYC)', group: 'Config' },
  { key: 'website.manage', label: 'Website & branding', group: 'Config' },
  { key: 'risk.manage', label: 'Risk & AML, onboarding scoring', group: 'Risk' },
  { key: 'ledger.view', label: 'Ledger (read-only)', group: 'Audit' },
  { key: 'staff.manage', label: 'Manage staff & permissions', group: 'Admin' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

/** Convenience presets the super admin can start a staff member from. */
export const PRESETS: Record<string, { label: string; permissions: string[] }> = {
  kyc_officer: { label: 'KYC Officer', permissions: ['kyc.review', 'users.view'] },
  finance: {
    label: 'Finance / Top-up',
    permissions: ['topup.manage', 'recon.manage', 'payouts.manage', 'tax.manage', 'risk.manage', 'users.view'],
  },
  support: { label: 'Support Agent', permissions: ['users.manage', 'ledger.view'] },
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Resolve the permission required for an admin-console request path (relative
 * to /admin) and HTTP method. Returns:
 *   - a permission string that the caller must hold,
 *   - null  -> allowed for any staff (e.g. the read-only dashboard),
 *   - 'DENY' -> no rule matched; fail closed (super admin only).
 */
export function permissionForPath(path: string, method: string): string | null | 'DENY' {
  const m = method.toUpperCase() as Method;
  const mutating = m !== 'GET';

  // Order matters: most specific first.
  if (/^\/dashboard\b/.test(path)) return null;

  // A user's probation tier is a risk control, not general user management.
  if (/^\/users\/[^/]+\/tier\b/.test(path)) return 'risk.manage';
  if (/^\/users\/[^/]+\/(status|reset-password|plan|services)\b/.test(path)) return 'users.manage';
  if (/^\/users\b/.test(path)) return mutating ? 'users.manage' : 'users.view';

  if (/^\/onboarding\b/.test(path)) return 'risk.manage';
  if (/^\/risk-events\b/.test(path)) return 'risk.manage';

  if (/^\/services\b/.test(path)) return 'providers.manage';
  if (/^\/providers\b/.test(path)) return 'providers.manage';
  if (/^\/commission-plans\b/.test(path)) return 'commission.manage';

  if (/^\/ledger\b/.test(path)) return 'ledger.view';

  if (/^\/payout-batches\b/.test(path)) return 'payouts.manage';
  if (/^\/treasury\b/.test(path)) return 'payouts.manage';
  if (/^\/recon\b/.test(path)) return 'recon.manage';
  if (/^\/adjustments\b/.test(path)) return 'recon.manage';

  if (/^\/site\b/.test(path)) return 'website.manage';
  if (/^\/integrations\b/.test(path)) return 'integrations.manage';

  if (/^\/tax(\b|-config)/.test(path) || /^\/tds\b/.test(path) || /^\/gst\b/.test(path)) return 'tax.manage';

  if (/^\/bank-accounts\b/.test(path)) return 'topup.manage';
  if (/^\/topups\b/.test(path)) return 'topup.manage';
  if (/^\/withdrawals\b/.test(path)) return 'payouts.manage';

  return 'DENY';
}
