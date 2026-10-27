-- AML / banned-business blocklist.
--
-- Admin-managed screening list. Before a transaction commits, the payee
-- identifiers it carries (account number, IFSC, UPI, mobile, PAN, name) and its
-- description are matched against active entries. An entry's action is either
-- 'block' (reject the transaction, 422) or 'flag' (allow but log a risk event
-- for the ops desk). Entirely panel-managed — Risk & AML screen.

CREATE TABLE IF NOT EXISTS aml_blocklist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL CHECK (kind IN ('account','ifsc','upi','mobile','pan','name','keyword')),
  value_norm  TEXT NOT NULL,                 -- normalized match value (lower/trim, no spaces for ids)
  label       TEXT,                          -- display value / note
  action      TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block','flag')),
  reason      TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One entry per (kind, value); re-adding updates in the app layer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aml_blocklist_kind_val ON aml_blocklist (kind, value_norm);
CREATE INDEX IF NOT EXISTS idx_aml_blocklist_active ON aml_blocklist (kind, value_norm) WHERE is_active;
