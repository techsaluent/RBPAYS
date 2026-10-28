import { query } from '../../../db';

/**
 * Distributor / master-distributor home dashboard: network health, today's
 * business by service across the whole downline, the member's own earnings,
 * and top downline performers. One call powers the rich distributor home.
 *
 * "today" / "this month" are India Standard Time. "active" = a downline member
 * with a successful transaction in the last 30 days; "today active" = one with
 * a successful transaction today.
 */

export interface DistributorDashboard {
  network: { total: number; active: number; today_active: number; inactive: number; by_role: Record<string, number> };
  today_business: Record<string, number>; // service_code -> today success GTV (paise)
  earnings: { today_paise: number; month_paise: number; lifetime_paise: number };
  top_retailers: Array<{ id: string; name: string; gtv_paise: number; txns: number }>;
  top_distributors: Array<{ id: string; name: string; gtv_paise: number; txns: number }>;
}

const DOWNLINE_CTE = `
  WITH RECURSIVE dl AS (
    SELECT id, role FROM users WHERE parent_id = $1
    UNION ALL
    SELECT u.id, u.role FROM users u JOIN dl ON u.parent_id = dl.id
  )`;

export async function distributorDashboard(userId: string): Promise<DistributorDashboard> {
  // 1) Network health: totals by role + active / today-active counts.
  const net = await query<{ total: string; active: string; today_active: string }>(
    `${DOWNLINE_CTE}
     SELECT
       (SELECT COUNT(*) FROM dl) AS total,
       (SELECT COUNT(DISTINCT t.user_id) FROM transactions t
          WHERE t.user_id IN (SELECT id FROM dl) AND t.status = 'success'
            AND t.created_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date - INTERVAL '30 days') AS active,
       (SELECT COUNT(DISTINCT t.user_id) FROM transactions t
          WHERE t.user_id IN (SELECT id FROM dl) AND t.status = 'success'
            AND (t.created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS today_active`,
    [userId],
  );
  const byRole = await query<{ role: string; n: string }>(
    `${DOWNLINE_CTE} SELECT role, COUNT(*) AS n FROM dl GROUP BY role`,
    [userId],
  );
  const total = Number(net.rows[0]?.total ?? 0);
  const active = Number(net.rows[0]?.active ?? 0);

  // 2) Today's business by service across the downline (success GTV).
  const biz = await query<{ service: string; gtv: string }>(
    `${DOWNLINE_CTE}
     SELECT t.service, COALESCE(SUM(t.amount_paise),0) AS gtv
       FROM transactions t
      WHERE t.user_id IN (SELECT id FROM dl) AND t.status = 'success'
        AND (t.created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
      GROUP BY t.service`,
    [userId],
  );
  const todayBusiness: Record<string, number> = {};
  for (const r of biz.rows) todayBusiness[r.service] = Number(r.gtv);

  // 3) My own commission earnings (today / month / lifetime).
  const earn = await query<{ today: string; month: string; lifetime: string }>(
    `SELECT
        COALESCE(SUM(amount_paise) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date),0) AS today,
        COALESCE(SUM(amount_paise) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata') = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')),0) AS month,
        COALESCE(SUM(amount_paise),0) AS lifetime
       FROM commission_entries WHERE beneficiary_id = $1`,
    [userId],
  );

  // 4) Top downline performers this month, by role bucket.
  const top = await query<{ id: string; name: string; role: string; gtv: string; txns: string }>(
    `${DOWNLINE_CTE}
     SELECT u.id, u.full_name AS name, u.role,
            COALESCE(SUM(t.amount_paise) FILTER (WHERE t.status='success'),0) AS gtv,
            COUNT(t.id) FILTER (WHERE t.status='success') AS txns
       FROM dl JOIN users u ON u.id = dl.id
       LEFT JOIN transactions t ON t.user_id = u.id
        AND date_trunc('month', t.created_at AT TIME ZONE 'Asia/Kolkata') = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')
      GROUP BY u.id, u.full_name, u.role
      HAVING COALESCE(SUM(t.amount_paise) FILTER (WHERE t.status='success'),0) > 0
      ORDER BY gtv DESC`,
    [userId],
  );
  const mapRow = (r: typeof top.rows[number]) => ({ id: r.id, name: r.name, gtv_paise: Number(r.gtv), txns: Number(r.txns) });

  return {
    network: {
      total,
      active,
      today_active: Number(net.rows[0]?.today_active ?? 0),
      inactive: Math.max(0, total - active),
      by_role: Object.fromEntries(byRole.rows.map((r) => [r.role, Number(r.n)])),
    },
    today_business: todayBusiness,
    earnings: {
      today_paise: Number(earn.rows[0]?.today ?? 0),
      month_paise: Number(earn.rows[0]?.month ?? 0),
      lifetime_paise: Number(earn.rows[0]?.lifetime ?? 0),
    },
    top_retailers: top.rows.filter((r) => r.role === 'retailer').slice(0, 5).map(mapRow),
    top_distributors: top.rows.filter((r) => r.role === 'distributor' || r.role === 'master_distributor').slice(0, 5).map(mapRow),
  };
}
