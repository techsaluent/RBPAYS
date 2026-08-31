-- =====================================================================
-- Default commission rules for the new Loan Repayment + Credit Card Bill
-- Payment services. Percent-based (amounts vary widely); the admin can tune
-- these under Commission afterwards. Added to every commission plan that
-- doesn't already carry a rule for the service.
-- =====================================================================
INSERT INTO commission_rules (
    plan_id, service_code,
    charge_type, charge_value,
    retailer_type, retailer_value,
    distributor_type, distributor_value,
    master_distributor_type, master_distributor_value,
    admin_type, admin_value
)
SELECT p.id, v.service_code,
       'percent', v.charge,
       'percent', v.retailer,
       'percent', v.dist,
       'percent', v.md,
       'percent', v.admin
FROM commission_plans p
CROSS JOIN (VALUES
    ('loan',        0.00, 0.40, 0.10, 0.05, 0.05),
    ('credit_card', 0.00, 0.35, 0.10, 0.05, 0.05)
) AS v(service_code, charge, retailer, dist, md, admin)
WHERE NOT EXISTS (
    SELECT 1 FROM commission_rules r WHERE r.plan_id = p.id AND r.service_code = v.service_code
);
