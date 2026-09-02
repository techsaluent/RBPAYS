-- 047_broadcasts.sql
-- Admin broadcast: send one message to a member audience over the configured
-- messaging channels (SMS / WhatsApp / Email), with per-send tallies.
CREATE TABLE IF NOT EXISTS broadcasts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject     TEXT,                                    -- used for email
    message     TEXT NOT NULL,
    channels    TEXT[] NOT NULL,                         -- {sms,whatsapp,email}
    audience    TEXT NOT NULL DEFAULT 'all',             -- all | retailer | distributor | master_distributor
    total       INT NOT NULL DEFAULT 0,
    sent        INT NOT NULL DEFAULT 0,
    failed      INT NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sending','done','failed')),
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS broadcasts_created_idx ON broadcasts (created_at DESC);
