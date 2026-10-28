/**
 * Seed a DEMO hierarchy so every panel can be logged into and tried:
 *   admin (existing)
 *     └─ DEMO Master Distributor      (also owns a white-label brand)
 *          └─ DEMO Distributor
 *               └─ DEMO Retailer
 *                    └─ DEMO Customer
 *
 * Each member gets a wallet funded with demo balance (credited cleanly through
 * the double-entry ledger, so the trial balance stays balanced). Idempotent:
 * existing demo users are reused and never re-funded, so it is safe to re-run.
 *
 *   DEMO_PASSWORD=Demo@12345 npm run seed:demo
 *
 * Login identifier is the email; the password is the same for all demo users.
 * Remove them later with:  npm run seed:demo -- --remove
 */
import { pool, withTransaction, query } from './index';
import { logger } from '../src/config/logger';
import { createMember } from '../src/modules/members/members.service';
import { credit } from '../src/modules/wallet/wallet.service';
import { postJournal } from '../src/modules/_shared/ledger';

const PASSWORD = process.env.DEMO_PASSWORD || 'Demo@12345';
const DOMAIN = 'tutipays.local'; // obviously-demo addresses

interface DemoSpec {
  key: string;
  full_name: string;
  role: 'master_distributor' | 'distributor' | 'retailer' | 'user';
  phone: string;
  fundRupees: number;
}

// Top-down so each member's parent exists first.
const CHAIN: DemoSpec[] = [
  { key: 'md', full_name: 'DEMO Master Distributor', role: 'master_distributor', phone: '9000000001', fundRupees: 500000 },
  { key: 'dist', full_name: 'DEMO Distributor', role: 'distributor', phone: '9000000002', fundRupees: 200000 },
  { key: 'retailer', full_name: 'DEMO Retailer', role: 'retailer', phone: '9000000003', fundRupees: 50000 },
  { key: 'customer', full_name: 'DEMO Customer', role: 'user', phone: '9000000004', fundRupees: 5000 },
];

const email = (key: string) => `demo.${key}@${DOMAIN}`;

async function removeDemo(): Promise<void> {
  // Delete demo users (cascades wallets, user_services, etc.); tenants.owner is set null.
  const { rowCount } = await query('DELETE FROM users WHERE email LIKE $1', [`demo.%@${DOMAIN}`]);
  await query('DELETE FROM tenants WHERE brand_name = $1', ['DEMO Brand']);
  logger.info({ removed: rowCount }, 'demo users removed');
}

/** Credit a demo wallet cleanly: DR treasury_in_transit (asset) / CR member_wallet. */
async function fund(userId: string, rupees: number): Promise<void> {
  if (rupees <= 0) return;
  const amountPaise = Math.round(rupees * 100);
  await withTransaction(async (client) => {
    await credit(client, { userId, amountPaise, source: 'adjustment', description: 'DEMO seed funding' });
    await postJournal(client, {
      source: 'demo_seed',
      narration: 'DEMO wallet funding',
      lines: [
        { account: 'treasury_in_transit', direction: 'debit', amountPaise },
        { account: 'member_wallet', direction: 'credit', amountPaise, walletUserId: userId },
      ],
    });
  });
}

async function main(): Promise<void> {
  if (process.argv.includes('--remove')) {
    await removeDemo();
    await pool.end();
    return;
  }
  if (PASSWORD.length < 8) throw new Error('DEMO_PASSWORD must be at least 8 characters');

  const admin = (await query<{ id: string }>("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1")).rows[0];
  if (!admin) throw new Error('No admin found — run `npm run seed:admin` first.');

  // parentId/parentRole for each role in the chain.
  const parents: Record<string, { id: string; role: string }> = {
    master_distributor: { id: admin.id, role: 'admin' },
  };
  const created: { label: string; email: string; role: string; funded: string }[] = [];

  for (const spec of CHAIN) {
    const mail = email(spec.key);
    const existing = (await query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [mail])).rows[0];
    let id: string;
    let funded = 'reused (not re-funded)';
    if (existing) {
      id = existing.id;
    } else {
      const parent = parents[spec.role];
      const member = await createMember({
        parentId: parent.id,
        parentRole: parent.role,
        full_name: spec.full_name,
        email: mail,
        phone: spec.phone,
        password: PASSWORD,
        role: spec.role,
      });
      id = member.id;
      await fund(id, spec.fundRupees);
      funded = `₹${spec.fundRupees.toLocaleString('en-IN')}`;
    }
    // The next role down hangs off this member.
    const childRole = CHAIN[CHAIN.indexOf(spec) + 1]?.role;
    if (childRole) parents[childRole] = { id, role: spec.role };
    created.push({ label: spec.full_name, email: mail, role: spec.role, funded });
  }

  // White-label brand owned by the DEMO Master Distributor (makes "My Brand" +
  // the partner dashboard available on that login).
  const mdId = (await query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [email('md')])).rows[0]?.id;
  if (mdId) {
    const t = await query<{ id: string }>('SELECT id FROM tenants WHERE owner_user_id = $1', [mdId]);
    if (!t.rowCount) {
      const ins = await query<{ id: string }>(
        `INSERT INTO tenants (owner_user_id, brand_name, logo_emoji, primary_color, tagline, status)
         VALUES ($1,'DEMO Brand','💠','#7C3AED','Your payments, your brand','active') RETURNING id`,
        [mdId],
      );
      await query('UPDATE users SET tenant_id = $1 WHERE id = $2', [ins.rows[0].id, mdId]);
      logger.info({ tenantId: ins.rows[0].id }, 'DEMO Brand tenant created for the master distributor');
    }
  }

  await pool.end();

  // Print a clear credentials summary.
  /* eslint-disable no-console */
  console.log('\n=============== DEMO LOGINS (password for all: ' + PASSWORD + ') ===============');
  console.log('Sign in at /panel with the EMAIL below.\n');
  for (const c of created) {
    console.log(`  ${c.role.padEnd(20)} ${c.email.padEnd(32)} wallet: ${c.funded}`);
  }
  console.log('  (DEMO Master Distributor also owns the "DEMO Brand" white-label — see My Brand / partner dashboard)');
  console.log('\nAdmin: your existing admin login is unchanged.');
  console.log('Remove all demo data later with:  npm run seed:demo -- --remove');
  console.log('===================================================================================\n');
}

main().catch((err) => {
  logger.error({ err }, 'seed-demo failed');
  process.exit(1);
});
