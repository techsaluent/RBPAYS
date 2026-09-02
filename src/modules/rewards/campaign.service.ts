import { query, withTransaction } from '../../../db';
import { credit } from '../wallet/wallet.service';
import { addNotification } from '../notify/notify.service';
import { ApiError } from '../../utils/ApiError';

/**
 * Milestone / prize-draw campaigns. An admin sets a target (successful txn
 * count or GTV) over a date window; members who hit it "qualify". A `cashback`
 * campaign pays every qualifier; a `draw` campaign randomly picks N winners.
 * Rewards credit the member's wallet and drop an in-app notification.
 */
export interface CampaignInput {
  name: string;
  metric: 'count' | 'gtv';
  target: number; // count, or paise for gtv
  from_date: string;
  to_date: string;
  reward_type: 'cashback' | 'draw';
  reward_paise: number;
  winners: number;
  createdBy: string;
}

export async function createCampaign(c: CampaignInput) {
  const { rows } = await query(
    `INSERT INTO reward_campaigns (name, metric, target, from_date, to_date, reward_type, reward_paise, winners, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [c.name, c.metric, c.target, c.from_date, c.to_date, c.reward_type, c.reward_paise, Math.max(1, c.winners), c.createdBy],
  );
  return rows[0];
}

export async function listCampaigns() {
  const { rows } = await query(
    `SELECT c.*, (SELECT COUNT(*) FROM campaign_awards a WHERE a.campaign_id = c.id) AS awarded_count
       FROM reward_campaigns c ORDER BY c.created_at DESC LIMIT 100`,
  );
  return rows;
}

/** Members (retailer/distributor/MD) who met the target in the window. */
export async function qualifiers(campaignId: string): Promise<Array<{ user_id: string; full_name: string; value: number }>> {
  const c = (await query('SELECT * FROM reward_campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!c) throw ApiError.notFound('Campaign not found');
  const agg = c.metric === 'gtv' ? 'COALESCE(SUM(t.amount_paise),0)' : 'COUNT(*)';
  const { rows } = await query<{ user_id: string; full_name: string; value: string }>(
    `SELECT t.user_id, u.full_name, ${agg} AS value
       FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE t.status = 'success'
        AND u.role = ANY(ARRAY['retailer','user','distributor','master_distributor'])
        AND (t.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3
      GROUP BY t.user_id, u.full_name
      HAVING ${agg} >= $1
      ORDER BY value DESC`,
    [c.target, c.from_date, c.to_date],
  );
  return rows.map((r) => ({ user_id: r.user_id, full_name: r.full_name, value: Number(r.value) }));
}

/**
 * Award a campaign: cashback pays every qualifier reward_paise; draw picks
 * `winners` random qualifiers. Idempotent per (campaign,user) via the unique
 * index. Marks the campaign awarded. Returns the winners.
 */
export async function awardCampaign(campaignId: string): Promise<Array<{ user_id: string; full_name: string; reward_paise: number }>> {
  const c = (await query('SELECT * FROM reward_campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!c) throw ApiError.notFound('Campaign not found');
  if (c.status === 'awarded') throw ApiError.conflict('Campaign already awarded');
  const elig = await qualifiers(campaignId);
  if (!elig.length) throw ApiError.badRequest('No members qualified for this campaign yet');

  let winners = elig;
  if (c.reward_type === 'draw') {
    // Fisher–Yates shuffle, take the first `winners`.
    const pool = [...elig];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    winners = pool.slice(0, Math.max(1, c.winners));
  }

  const reward = Number(c.reward_paise);
  await withTransaction(async (client) => {
    for (const w of winners) {
      const ins = await client.query(
        'INSERT INTO campaign_awards (campaign_id, user_id, reward_paise) VALUES ($1,$2,$3) ON CONFLICT (campaign_id,user_id) DO NOTHING RETURNING id',
        [campaignId, w.user_id, reward],
      );
      if (ins.rowCount && reward > 0) {
        await credit(client, {
          userId: w.user_id,
          amountPaise: reward,
          source: 'adjustment',
          referenceId: campaignId,
          description: `Reward: ${c.name}`,
        });
      }
    }
    await client.query("UPDATE reward_campaigns SET status = 'awarded', awarded_at = now() WHERE id = $1", [campaignId]);
  });

  // Best-effort in-app notification to each winner (outside the money tx).
  for (const w of winners) {
    void addNotification(w.user_id, 'info', 'You earned a reward! 🎁', `${c.name}: ₹${(reward / 100).toFixed(2)} credited to your wallet.`);
  }
  return winners.map((w) => ({ user_id: w.user_id, full_name: w.full_name, reward_paise: reward }));
}

/** Active campaigns a member can see, with the member's own progress. */
export async function memberCampaigns(userId: string) {
  const camps = (await query(
    "SELECT id, name, metric, target, from_date, to_date, reward_type, reward_paise, winners, status FROM reward_campaigns WHERE status = 'active' ORDER BY to_date",
  )).rows;
  const out = [];
  for (const c of camps) {
    const agg = c.metric === 'gtv' ? 'COALESCE(SUM(amount_paise),0)' : 'COUNT(*)';
    const { rows } = await query<{ v: string }>(
      `SELECT ${agg} AS v FROM transactions
        WHERE user_id = $1 AND status = 'success'
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3`,
      [userId, c.from_date, c.to_date],
    );
    out.push({ ...c, target: Number(c.target), reward_paise: Number(c.reward_paise), my_value: Number(rows[0].v) });
  }
  return out;
}
