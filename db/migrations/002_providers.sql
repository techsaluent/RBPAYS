-- =====================================================================
-- Provider integration: track which provider handled each transaction,
-- store status messages, and add an idempotent webhook/event log.
-- =====================================================================

-- Which provider processed each service transaction + a human message.
ALTER TABLE dmt_transactions      ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE dmt_transactions      ADD COLUMN IF NOT EXISTS status_message TEXT;
ALTER TABLE bbps_transactions     ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE bbps_transactions     ADD COLUMN IF NOT EXISTS status_message TEXT;
ALTER TABLE recharge_transactions ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE recharge_transactions ADD COLUMN IF NOT EXISTS status_message TEXT;
ALTER TABLE payout_transactions   ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE payout_transactions   ADD COLUMN IF NOT EXISTS status_message TEXT;
ALTER TABLE pg_orders             ADD COLUMN IF NOT EXISTS status_message TEXT;

-- Flag so a reversal (wallet credit-back on failure) happens at most once
-- per transaction, even if a webhook and a poll both report failure.
ALTER TABLE dmt_transactions      ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE bbps_transactions     ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE recharge_transactions ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE payout_transactions   ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

-- ---------- Provider event log (webhook idempotency + audit) ---------
CREATE TABLE IF NOT EXISTS provider_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider      TEXT NOT NULL,               -- razorpay, aggregator, ...
    event_type    TEXT,                         -- payment.captured, payout.processed, ...
    external_id   TEXT,                         -- provider's event/payment id
    payload       JSONB,
    processed     BOOLEAN NOT NULL DEFAULT false,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Same provider event delivered twice must collapse to one row.
    UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS provider_events_type_idx ON provider_events (provider, event_type);
