import { query } from '../../../db';

/**
 * Business analytics — platform-wide (admin) and per-member.
 * All money is integer paise; days are IST calendar days. Ranges are inclusive
 * of today and go back `days` days.
 */
function clampDays(days: number): number {
  return Math.min(365, Math.max(1, Math.floor(days) || 30));
}

interface DayPoint {
  day: string;
  gtv_paise: number;
  count: number;
  revenue_paise: number;
}

/** Platform analytics: GTV + revenue trend, service mix, top members. */
export async function platformAnalytics(days: number) {
  const d = clampDays(days);
  const since = `(now() AT TIME ZONE 'Asia/Kolkata')::date - INTERVAL '${d - 1} days'`;

  // Daily GTV/count (successful) + platform revenue (admin-level commission).
  const trend = await query<{ day: string; gtv: string; count: string; revenue: string }>(
    `WITH days AS (
        SELECT generate_series(${since}, (now() AT TIME ZONE 'Asia/Kolkata')::date, INTERVAL '1 day')::date AS day
     )
     SELECT to_char(dd.day,'YYYY-MM-DD') AS day,
            COALESCE(SUM(x.amount_paise) FILTER (WHERE x.status='success'),0) AS gtv,
            COUNT(x.id) FILTER (WHERE x.status='success') AS count,
            COALESCE((SELECT SUM(ce.amount_paise) FROM commission_entries ce
                       WHERE ce.level='admin'
                         AND (ce.created_at AT TIME ZONE 'Asia/Kolkata')::date = dd.day),0) AS revenue
       FROM days dd
       LEFT JOIN transactions x ON (x.created_at AT TIME ZONE 'Asia/Kolkata')::date = dd.day
      GROUP BY dd.day ORDER BY dd.day`,
  );
  const daily: DayPoint[] = trend.rows.map((r) => ({
    day: r.day, gtv_paise: Number(r.gtv), count: Number(r.count), revenue_paise: Number(r.revenue),
  }));

  // Service mix over the range (successful).
  const mix = await query<{ service: string; count: string; gtv: string }>(
    `SELECT service, COUNT(*) AS count, COALESCE(SUM(amount_paise),0) AS gtv
       FROM transactions
      WHERE status='success' AND created_at >= ${since}
      GROUP BY service ORDER BY gtv DESC`,
  );

  // Top members by successful GTV in the range.
  const top = await query<{ user_id: string; full_name: string; role: string; count: string; gtv: string }>(
    `SELECT t.user_id, u.full_name, u.role, COUNT(*) AS count, COALESCE(SUM(t.amount_paise),0) AS gtv
       FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE t.status='success' AND t.created_at >= ${since}
      GROUP BY t.user_id, u.full_name, u.role
      ORDER BY gtv DESC LIMIT 10`,
  );

  const totals = daily.reduce(
    (a, p) => ({ gtv_paise: a.gtv_paise + p.gtv_paise, count: a.count + p.count, revenue_paise: a.revenue_paise + p.revenue_paise }),
    { gtv_paise: 0, count: 0, revenue_paise: 0 },
  );

  return {
    days: d,
    daily,
    service_mix: mix.rows.map((r) => ({ service: r.service, count: Number(r.count), gtv_paise: Number(r.gtv) })),
    top_members: top.rows.map((r) => ({ user_id: r.user_id, full_name: r.full_name, role: r.role, count: Number(r.count), gtv_paise: Number(r.gtv) })),
    totals,
  };
}

/** Member analytics: my earnings trend, my service mix, my totals. */
export async function memberAnalytics(userId: string, days: number) {
  const d = clampDays(days);
  const since = `(now() AT TIME ZONE 'Asia/Kolkata')::date - INTERVAL '${d - 1} days'`;

  // Daily: my successful GTV/count + my commission earned (as beneficiary).
  const trend = await query<{ day: string; gtv: string; count: string; earned: string }>(
    `WITH days AS (
        SELECT generate_series(${since}, (now() AT TIME ZONE 'Asia/Kolkata')::date, INTERVAL '1 day')::date AS day
     )
     SELECT to_char(dd.day,'YYYY-MM-DD') AS day,
            COALESCE(SUM(x.amount_paise) FILTER (WHERE x.status='success'),0) AS gtv,
            COUNT(x.id) FILTER (WHERE x.status='success') AS count,
            COALESCE((SELECT SUM(ce.amount_paise) FROM commission_entries ce
                       WHERE ce.beneficiary_id=$1
                         AND (ce.created_at AT TIME ZONE 'Asia/Kolkata')::date = dd.day),0) AS earned
       FROM days dd
       LEFT JOIN transactions x ON (x.created_at AT TIME ZONE 'Asia/Kolkata')::date = dd.day AND x.user_id=$1
      GROUP BY dd.day ORDER BY dd.day`,
    [userId],
  );
  const daily = trend.rows.map((r) => ({ day: r.day, gtv_paise: Number(r.gtv), count: Number(r.count), earned_paise: Number(r.earned) }));

  const mix = await query<{ service: string; count: string; gtv: string }>(
    `SELECT service, COUNT(*) AS count, COALESCE(SUM(amount_paise),0) AS gtv
       FROM transactions
      WHERE user_id=$1 AND status='success' AND created_at >= ${since}
      GROUP BY service ORDER BY gtv DESC`,
    [userId],
  );

  const totals = daily.reduce(
    (a, p) => ({ gtv_paise: a.gtv_paise + p.gtv_paise, count: a.count + p.count, earned_paise: a.earned_paise + p.earned_paise }),
    { gtv_paise: 0, count: 0, earned_paise: 0 },
  );

  return {
    days: d,
    daily,
    service_mix: mix.rows.map((r) => ({ service: r.service, count: Number(r.count), gtv_paise: Number(r.gtv) })),
    totals,
  };
}
