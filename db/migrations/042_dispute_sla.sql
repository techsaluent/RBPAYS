-- 042_dispute_sla.sql
-- Dispute SLA tracking: every dispute gets a resolution deadline so the ops
-- desk can see what is overdue and prioritise it. The default SLA (hours) is
-- admin-configurable; money-stuck categories resolve faster (set in code).

ALTER TABLE disputes ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ;

-- Backfill existing unresolved disputes with a 24h-from-creation deadline so
-- the overdue view is meaningful immediately after deploy.
UPDATE disputes
   SET sla_due_at = created_at + interval '24 hours'
 WHERE sla_due_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_disputes_sla ON disputes (sla_due_at)
  WHERE status IN ('open', 'in_review');

-- Default SLA window (hours) — admin can tune under Website settings.
INSERT INTO site_settings (key, value) VALUES ('dispute_sla_hours', '24')
  ON CONFLICT (key) DO NOTHING;
