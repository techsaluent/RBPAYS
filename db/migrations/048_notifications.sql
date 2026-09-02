-- 048_notifications.sql
-- In-app notification inbox. Mirrors the member alerts (transaction, KYC,
-- low-balance) and admin broadcasts as inbox entries the member reads in the
-- panel, independent of whether the SMS/WhatsApp/Email channels are on.
CREATE TABLE IF NOT EXISTS notifications (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL DEFAULT 'info',   -- txn | kyc | balance | broadcast | info
    title      TEXT NOT NULL,
    body       TEXT,
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
