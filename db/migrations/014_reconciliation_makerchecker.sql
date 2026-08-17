-- =====================================================================
-- EOD reconciliation + maker-checker ops desk.
--   Reconciliation ingests a bank/switch settlement feed (MIS) and matches
--   it against the internal ledger, auto-remediating timeouts (force-settle)
--   and flagging false-successes for dual-control review.
-- =====================================================================

CREATE TABLE IF NOT EXISTS recon_batches (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label         TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'bank_mis',
    total_records INT NOT NULL DEFAULT 0,
    matched       INT NOT NULL DEFAULT 0,
    force_settled INT NOT NULL DEFAULT 0,
    exceptions    INT NOT NULL DEFAULT 0,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recon_records (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id      UUID NOT NULL REFERENCES recon_batches(id) ON DELETE CASCADE,
    reference     TEXT,
    rrn           TEXT,
    bank_status   TEXT,               -- settled | reversed | not_found
    amount_paise  BIGINT,
    txn_id        UUID,               -- matched internal transaction
    match_status  TEXT NOT NULL,      -- matched | force_settled | false_success | amount_mismatch | unrecognized
    action        TEXT NOT NULL DEFAULT 'none',
    detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recon_records_batch_idx ON recon_records (batch_id);
CREATE INDEX IF NOT EXISTS recon_records_status_idx ON recon_records (match_status);

-- ---------- Maker-checker manual adjustments -------------------------
-- One officer proposes a high-value / sensitive change; a DIFFERENT officer
-- approves it. Only on approval is the wallet + journal effect applied.
CREATE TABLE IF NOT EXISTS manual_adjustments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_user  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('credit','debit','clawback')),
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    reason       TEXT NOT NULL,
    reference    TEXT,
    status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
    maker_id     UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    checker_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    checker_note TEXT,
    journal_ref  UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS manual_adj_status_idx ON manual_adjustments (status, created_at DESC);
