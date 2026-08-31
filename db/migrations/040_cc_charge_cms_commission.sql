-- =====================================================================
-- Tune the money model for two services:
--   * Credit Card Bill Payment → charge-based like DMT: levy a convenience
--     charge (fee the customer pays) alongside the retailer commission.
--   * CMS (cash collection) → earn commission for the retailer (it had none).
-- Admins can still tune all of this under Commission.
-- =====================================================================

-- Credit card: add a 1% convenience charge (fee) on top of the commission.
UPDATE commission_rules
   SET charge_type  = 'percent',
       charge_value = 1.0000
 WHERE service_code = 'credit_card';

-- CMS: seed a commission rule (retailer earns) for every plan that lacks one.
INSERT INTO commission_rules (
    plan_id, service_code,
    charge_type, charge_value,
    retailer_type, retailer_value,
    distributor_type, distributor_value,
    master_distributor_type, master_distributor_value,
    admin_type, admin_value
)
SELECT p.id, 'cms',
       'percent', 0.00,
       'percent', 0.50,
       'percent', 0.10,
       'percent', 0.05,
       'percent', 0.05
FROM commission_plans p
WHERE NOT EXISTS (
    SELECT 1 FROM commission_rules r WHERE r.plan_id = p.id AND r.service_code = 'cms'
);
