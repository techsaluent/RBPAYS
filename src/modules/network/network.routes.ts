import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { usernameSchema } from '../auth/auth.schemas';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { getWalletByUser, debit, credit } from '../wallet/wallet.service';
import { earningsFor } from '../commission/commission.service';
import { query, withTransaction } from '../../../db';
import { rupeesToPaise } from '../../utils/money';
import { postJournal } from '../_shared/ledger';
import {
  createMember,
  downlineCounts,
  downlineTree,
  listDownline,
} from '../members/members.service';

const router = Router();
router.use(requireAuth);

// Only distribution members have a panel/network.
function requireMember(req: Request): { id: string; role: string } {
  if (!req.user) throw ApiError.unauthorized();
  if (!['retailer', 'distributor', 'master_distributor'].includes(req.user.role)) {
    throw ApiError.forbidden('Only retailers, distributors and master distributors have a panel');
  }
  return req.user;
}

// Panel dashboard: wallet, downline counts, earnings summary.
router.get(
  '/panel',
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    const [wallet, counts, earnings] = await Promise.all([
      getWalletByUser(me.id),
      downlineCounts(me.id),
      earningsFor(me.id, 5),
    ]);
    res.json({
      role: me.role,
      wallet,
      downline_counts: counts,
      earnings: { total_paise: earnings.total_paise, count: earnings.count, recent: earnings.items },
    });
  }),
);

const createMemberSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  username: usernameSchema.optional(),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
  password: z.string().min(8).max(128),
  role: z.enum(['retailer', 'distributor', 'master_distributor']),
});

// Onboard a downline member below me (rank-checked in the service).
router.post(
  '/members',
  validate(createMemberSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    const b = req.body as z.infer<typeof createMemberSchema>;
    const member = await createMember({ parentId: me.id, parentRole: me.role, ...b });
    res.status(201).json({ member });
  }),
);

const floatSchema = z.object({
  to_user_id: z.string().uuid().optional(),
  to_username: z.string().trim().optional(),
  amount: z.coerce.number().positive().max(1_000_000),
  note: z.string().trim().max(200).optional(),
}).refine((v) => v.to_user_id || v.to_username, {
  message: 'Provide to_user_id or to_username',
});

// Float push: a distributor / master distributor tops up a DIRECT downline
// member's wallet from their own balance. Double-entry inter-liability
// transfer (parent wallet -> child wallet), atomic with the balance moves.
router.post(
  '/float',
  validate(floatSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    if (me.role === 'retailer') {
      throw ApiError.forbidden('Retailers cannot push float; only distributors and master distributors can');
    }
    const b = req.body as z.infer<typeof floatSchema>;

    // Resolve the target and confirm they are a direct downline of mine.
    const { rows: tgt } = await query<{ id: string; parent_id: string | null; full_name: string }>(
      b.to_user_id
        ? 'SELECT id, parent_id, full_name FROM users WHERE id = $1'
        : 'SELECT id, parent_id, full_name FROM users WHERE username = $1',
      [b.to_user_id ?? b.to_username],
    );
    const target = tgt[0];
    if (!target) throw ApiError.notFound('Member not found');
    if (target.id === me.id) throw ApiError.badRequest('Cannot push float to yourself');
    if (target.parent_id !== me.id) {
      throw ApiError.forbidden('You can only push float to your own direct downline members');
    }

    const amountPaise = rupeesToPaise(b.amount);
    const result = await withTransaction(async (client) => {
      // Debit parent (validates sufficient balance under a row lock),
      // credit child, then record the balanced journal entry.
      await debit(client, {
        userId: me.id,
        amountPaise,
        source: 'float_transfer',
        description: `Float to ${target.full_name}`,
      });
      await credit(client, {
        userId: target.id,
        amountPaise,
        source: 'float_transfer',
        description: `Float from ${req.user?.role?.replace(/_/g, ' ')}`,
      });
      await postJournal(client, {
        source: 'float_transfer',
        narration: b.note ?? `Float ${me.role} -> ${target.full_name}`,
        lines: [
          { account: 'member_wallet', direction: 'debit', amountPaise, walletUserId: me.id },
          { account: 'member_wallet', direction: 'credit', amountPaise, walletUserId: target.id },
        ],
      });
      const w = await client.query<{ balance_paise: string }>(
        'SELECT balance_paise FROM wallets WHERE user_id = $1',
        [me.id],
      );
      return { balance_paise: Number(w.rows[0].balance_paise) };
    });

    res.status(201).json({
      float: { to: target.full_name, amount_paise: amountPaise },
      my_balance_paise: result.balance_paise,
    });
  }),
);

const listSchema = z.object({
  role: z.enum(['retailer', 'distributor', 'master_distributor']).optional(),
});

// Direct downline (optionally filtered by role).
router.get(
  '/members',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    const q = req.query as unknown as z.infer<typeof listSchema>;
    res.json({ items: await listDownline(me.id, q.role) });
  }),
);

// Full downline tree.
router.get(
  '/downline',
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    res.json({ items: await downlineTree(me.id) });
  }),
);

const earningsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// My commission earnings.
router.get(
  '/earnings',
  validate(earningsSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    const q = req.query as unknown as z.infer<typeof earningsSchema>;
    res.json(await earningsFor(me.id, q.limit, q.offset));
  }),
);

// ---------------------------------------------------------------------
// Service management over the downline: an upline turns each service on/off
// for a DIRECT downline member (distributor → retailer, MD → distributor…).
// You can only grant a service you yourself have active — never widen access
// beyond your own.
// ---------------------------------------------------------------------
async function requireDirectChild(meId: string, childId: string): Promise<void> {
  const { rows } = await query<{ parent_id: string | null }>('SELECT parent_id FROM users WHERE id = $1', [childId]);
  if (!rows[0]) throw ApiError.notFound('Member not found');
  if (rows[0].parent_id !== meId) throw ApiError.forbidden('Not your direct downline member');
}

// List a direct-downline member's services with active flags, marking which
// ones the caller is allowed to grant (i.e. has active themselves).
router.get(
  '/members/:id/services',
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    await requireDirectChild(me.id, req.params.id);
    const { rows } = await query<{ code: string; name: string; enabled: boolean; child_active: boolean | null; mine_active: boolean | null }>(
      `SELECT s.code, s.name, s.enabled,
              cu.active AS child_active,
              mu.active AS mine_active
         FROM services s
         LEFT JOIN user_services cu ON cu.service_code = s.code AND cu.user_id = $2
         LEFT JOIN user_services mu ON mu.service_code = s.code AND mu.user_id = $1
        WHERE s.enabled = true
        ORDER BY s.code`,
      [me.id, req.params.id],
    );
    res.json({
      items: rows.map((r) => ({
        code: r.code, name: r.name,
        active: r.child_active === true,
        // The caller may toggle it only if they hold it (or are admin — admins use the admin UI).
        can_grant: r.mine_active === true || me.role === 'admin',
      })),
    });
  }),
);

router.put(
  '/members/:id/services/:code',
  validate(z.object({ active: z.boolean() })),
  asyncHandler(async (req: Request, res: Response) => {
    const me = requireMember(req);
    await requireDirectChild(me.id, req.params.id);
    const active = (req.body as { active: boolean }).active;
    const code = req.params.code;

    const svc = await query<{ enabled: boolean }>('SELECT enabled FROM services WHERE code = $1', [code]);
    if (!svc.rows[0]) throw ApiError.notFound('Unknown service');
    if (svc.rows[0].enabled === false) throw ApiError.badRequest('Service is disabled platform-wide');

    if (active) {
      const mine = await query('SELECT 1 FROM user_services WHERE user_id = $1 AND service_code = $2 AND active = true', [me.id, code]);
      if (!mine.rowCount && me.role !== 'admin') throw ApiError.forbidden(`You don't have ${code} active, so you can't grant it`);
    }
    await query(
      `INSERT INTO user_services (user_id, service_code, active) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, service_code) DO UPDATE SET active = EXCLUDED.active`,
      [req.params.id, code, active],
    );
    res.json({ ok: true, code, active });
  }),
);

export default router;
