import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes';
import walletRoutes from './modules/wallet/wallet.routes';
import beneficiaryRoutes from './modules/beneficiaries/beneficiaries.routes';
import dmtRoutes from './modules/dmt/dmt.routes';
import bbpsRoutes from './modules/bbps/bbps.routes';
import rechargeRoutes from './modules/recharge/recharge.routes';
import payoutRoutes from './modules/payout/payout.routes';
import pgRoutes from './modules/payment-gateway/pg.routes';
import kycRoutes from './modules/kyc/kyc.routes';
import networkRoutes from './modules/network/network.routes';
import adminRoutes from './modules/admin/admin.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/wallet', walletRoutes);
router.use('/beneficiaries', beneficiaryRoutes);
router.use('/dmt', dmtRoutes);
router.use('/bbps', bbpsRoutes);
router.use('/recharge', rechargeRoutes);
router.use('/payout', payoutRoutes);
router.use('/payment-gateway', pgRoutes);
router.use('/kyc', kycRoutes);
router.use('/network', networkRoutes);
router.use('/admin', adminRoutes);

export default router;
