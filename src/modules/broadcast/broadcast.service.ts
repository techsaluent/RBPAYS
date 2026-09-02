import { query } from '../../../db';
import { logger } from '../../config/logger';
import { dispatch, Channel } from '../notify/notify.service';

/**
 * Admin broadcast: send one message to a member audience over the enabled
 * messaging channels. Sending runs in the background (best-effort, never
 * throws) and updates the broadcast row's sent/failed tallies as it goes, so a
 * large audience never blocks the HTTP request.
 */
export type Audience = 'all' | 'retailer' | 'distributor' | 'master_distributor';

/** SQL role filter for an audience. 'all' = every member role (not staff/admin). */
function audienceRoles(a: Audience): string[] {
  if (a === 'all') return ['retailer', 'user', 'distributor', 'master_distributor'];
  return [a];
}

/** How many active members a broadcast to this audience would reach. */
export async function countRecipients(a: Audience): Promise<number> {
  const { rows } = await query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND role = ANY($1)",
    [audienceRoles(a)],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface BroadcastInput {
  subject?: string;
  message: string;
  channels: Channel[];
  audience: Audience;
  createdBy: string;
}

/** Create the broadcast row and kick off sending in the background. */
export async function createBroadcast(input: BroadcastInput) {
  const total = await countRecipients(input.audience);
  const { rows } = await query(
    `INSERT INTO broadcasts (subject, message, channels, audience, total, status, created_by)
     VALUES ($1,$2,$3,$4,$5,'queued',$6) RETURNING *`,
    [input.subject ?? null, input.message, input.channels, input.audience, total, input.createdBy],
  );
  const broadcast = rows[0];
  // Fire-and-forget; the request returns immediately with the queued row.
  void runBroadcast(broadcast.id, input);
  return broadcast;
}

/** Send the broadcast to every active member in the audience, tallying results. */
export async function runBroadcast(id: string, input: BroadcastInput): Promise<void> {
  try {
    await query("UPDATE broadcasts SET status = 'sending' WHERE id = $1", [id]);
    // In-app inbox: one entry per targeted member (independent of channels).
    await query(
      `INSERT INTO notifications (user_id, type, title, body)
         SELECT id, 'broadcast', COALESCE($2,'Announcement'), $3
           FROM users WHERE status = 'active' AND role = ANY($1)`,
      [audienceRoles(input.audience), input.subject ?? null, input.message],
    ).catch((err) => logger.warn({ err: (err as Error).message }, 'broadcast inbox insert failed'));
    const { rows } = await query<{ phone: string | null; email: string | null }>(
      "SELECT phone, email FROM users WHERE status = 'active' AND role = ANY($1)",
      [audienceRoles(input.audience)],
    );

    let sent = 0;
    let failed = 0;
    const CONCURRENCY = 8;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((u) =>
          dispatch({ phone: u.phone, email: u.email, text: input.message, subject: input.subject, channels: input.channels })
            .then((r) => r.sms || r.whatsapp || r.email)
            .catch(() => false),
        ),
      );
      for (const ok of results) ok ? sent++ : failed++;
      // Persist progress so the admin sees a live count.
      await query('UPDATE broadcasts SET sent = $2, failed = $3 WHERE id = $1', [id, sent, failed]);
    }

    await query("UPDATE broadcasts SET status = 'done', sent = $2, failed = $3, finished_at = now() WHERE id = $1", [id, sent, failed]);
    logger.info({ id, sent, failed, total: rows.length }, 'broadcast complete');
  } catch (err) {
    logger.error({ id, err: (err as Error).message }, 'broadcast failed');
    await query("UPDATE broadcasts SET status = 'failed', finished_at = now() WHERE id = $1", [id]).catch(() => {});
  }
}

/** List recent broadcasts with their tallies. */
export async function listBroadcasts(limit = 50) {
  const { rows } = await query(
    `SELECT b.*, u.full_name AS created_by_name
       FROM broadcasts b LEFT JOIN users u ON u.id = b.created_by
      ORDER BY b.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
