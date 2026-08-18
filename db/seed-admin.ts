/**
 * Seed the first admin account and a default commission plan.
 * Reads ADMIN_NAME / ADMIN_EMAIL / ADMIN_PHONE / ADMIN_PASSWORD from env.
 * Idempotent: skips creation if an admin already exists.
 *
 *   ADMIN_EMAIL=... ADMIN_PHONE=... ADMIN_PASSWORD=... npm run seed:admin
 */
import { pool } from './index';
import { logger } from '../src/config/logger';
import { hashPassword } from '../src/utils/password';

async function main(): Promise<void> {
  const name = process.env.ADMIN_NAME ?? 'REAL BROTHERS TECHNOLOGY SERVICES LLP';
  const email = (process.env.ADMIN_EMAIL ?? 'admin@tutipays.com').trim().toLowerCase();
  const phone = (process.env.ADMIN_PHONE ?? '').trim();
  const password = process.env.ADMIN_PASSWORD ?? '';

  if (!email || !phone || !password) {
    throw new Error('Set ADMIN_EMAIL, ADMIN_PHONE and ADMIN_PASSWORD to seed the admin');
  }
  if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Default commission plan.
    const planRes = await client.query<{ id: string }>(
      `INSERT INTO commission_plans (name, description, is_default)
       VALUES ('Default Plan', 'Auto-created default commission plan', true)
       ON CONFLICT (name) DO UPDATE SET is_default = true
       RETURNING id`,
    );
    logger.info({ planId: planRes.rows[0].id }, 'default commission plan ready');

    const existing = await client.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (existing.rowCount) {
      logger.info('an admin already exists; skipping admin creation');
      await client.query('COMMIT');
      return;
    }

    const password_hash = await hashPassword(password);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (full_name, email, phone, password_hash, role, status, kyc_status, activated_at)
       VALUES ($1,$2,$3,$4,'admin','active','verified', now())
       RETURNING id`,
      [name, email, phone, password_hash],
    );
    const adminId = rows[0].id;
    await client.query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [adminId]);

    await client.query('COMMIT');
    logger.info({ adminId, email, phone }, 'admin account created');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, 'seed-admin failed');
  process.exit(1);
});
