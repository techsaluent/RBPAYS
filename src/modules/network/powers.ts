import { ROLE_RANK } from '../members/members.service';

/**
 * Central hierarchy power map — the single source of truth for what each
 * network role may do over itself and its downline. Routes, the panel and
 * the dashboards all read from here so a capability is defined in exactly
 * one place (no drift between what the API enforces and what the UI shows).
 *
 * A capability is held by a role if the role's rank is >= the capability's
 * minimum rank. Ranks come from ROLE_RANK (user 0 → admin 4). The special
 * `tenant_owner` flag (a member who owns a white-label tenant) adds the
 * partner-console capabilities on top of their base role.
 */

export interface Capability {
  key: string;
  label: string;
  group: string;
  minRank: number; // lowest ROLE_RANK that holds it
  note?: string;
}

const R = ROLE_RANK;

export const CAPABILITIES: Capability[] = [
  // --- Network ---
  { key: 'member.create', label: 'Create downline members (strictly lower rank)', group: 'Network', minRank: R.distributor,
    note: 'Retailers are the leaf role and have no downline.' },
  { key: 'member.view', label: 'View own downline tree & members', group: 'Network', minRank: R.distributor },
  { key: 'member.services.manage', label: 'Enable / disable a downline member’s services', group: 'Network', minRank: R.distributor,
    note: 'Can only grant services the upline holds itself.' },
  { key: 'member.policy.manage', label: 'Set downline txn limits & payout OTP/KYC gates', group: 'Network', minRank: R.distributor },

  // --- Money ---
  { key: 'wallet.selfservice', label: 'Own wallet: top-up request, passbook, statement', group: 'Money', minRank: R.retailer },
  { key: 'wallet.sweep', label: 'Sweep commission / settlement sub-wallet to main', group: 'Money', minRank: R.retailer },
  { key: 'wallet.withdraw', label: 'Withdraw wallet balance to bank', group: 'Money', minRank: R.retailer },
  { key: 'downline.fund', label: 'Fund a downline wallet (float push / approve top-up)', group: 'Money', minRank: R.distributor,
    note: 'Retailers cannot fund a downline — they are the leaf role.' },

  // --- Policy over self ---
  { key: 'policy.self.view', label: 'View own limits & payout policy', group: 'Policy', minRank: R.retailer },

  // --- Developer ---
  { key: 'devapi.self', label: 'Own developer API keys for enabled services', group: 'Developer', minRank: R.retailer },

  // --- Reports ---
  { key: 'reports.self', label: 'Own transaction / TDS statements (CSV / Excel / PDF)', group: 'Reports', minRank: R.retailer },
  { key: 'reports.downline', label: 'Downline performance & settlement reports', group: 'Reports', minRank: R.distributor },
];

export interface PowerProfile {
  role: string;
  rank: number;
  tenant_owner: boolean;
  capabilities: string[]; // keys the role holds
}

/** The capability keys a role holds (admin/staff hold everything network-side). */
export function capabilitiesForRole(role: string, tenantOwner = false): string[] {
  const rank = role === 'admin' || role === 'staff' ? R.admin : (ROLE_RANK[role] ?? 0);
  const keys = CAPABILITIES.filter((c) => rank >= c.minRank).map((c) => c.key);
  if (tenantOwner) keys.push('partner.console', 'partner.branding', 'partner.billing');
  return keys;
}

/** Does a role hold a given capability? Used by routes to enforce centrally. */
export function roleCan(role: string, capability: string, tenantOwner = false): boolean {
  if (role === 'admin') return true;
  return capabilitiesForRole(role, tenantOwner).includes(capability);
}

/** Full profile for the signed-in member (for the panel's "Your powers" view). */
export function powerProfile(role: string, tenantOwner = false): PowerProfile {
  const rank = role === 'admin' || role === 'staff' ? R.admin : (ROLE_RANK[role] ?? 0);
  return { role, rank, tenant_owner: tenantOwner, capabilities: capabilitiesForRole(role, tenantOwner) };
}

/** The whole matrix (roles × capabilities) for an at-a-glance power map. */
export function powerMatrix(): { roles: string[]; capabilities: Capability[]; grid: Record<string, Record<string, boolean>> } {
  const roles = ['retailer', 'distributor', 'master_distributor', 'admin'];
  const grid: Record<string, Record<string, boolean>> = {};
  for (const c of CAPABILITIES) {
    grid[c.key] = {};
    for (const role of roles) grid[c.key][role] = (ROLE_RANK[role] ?? 0) >= c.minRank;
  }
  return { roles, capabilities: CAPABILITIES, grid };
}
