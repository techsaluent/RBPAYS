import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { query } from '../../../db';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  account_number: z.string().trim().regex(/^\d{6,20}$/, 'Invalid account number'),
  ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
  bank_name: z.string().trim().max(120).optional(),
});

router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const b = req.body as z.infer<typeof createSchema>;
    const { rows } = await query(
      `INSERT INTO beneficiaries (user_id, name, account_number, ifsc, bank_name)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [req.user.id, b.name, b.account_number, b.ifsc, b.bank_name ?? null],
    );
    res.status(201).json({ beneficiary: rows[0] });
  }),
);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rows } = await query(
      'SELECT * FROM beneficiaries WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id],
    );
    res.json({ items: rows });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { rowCount } = await query(
      'DELETE FROM beneficiaries WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!rowCount) throw ApiError.notFound('Beneficiary not found');
    res.status(204).send();
  }),
);

export default router;
