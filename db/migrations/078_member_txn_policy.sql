-- Per-member transaction policy: amount limits (differentiated by the member's
-- KYC state) and payout gates. Set by the member and overridable by an upline.
-- 0 = no limit. Enforced centrally before a transaction commits.

CREATE TABLE IF NOT EXISTS member_txn_policy (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  min_txn_paise           BIGINT NOT NULL DEFAULT 0,   -- KYC-verified floor per txn
  max_txn_paise           BIGINT NOT NULL DEFAULT 0,   -- KYC-verified cap per txn (0 = none)
  min_txn_nonkyc_paise    BIGINT NOT NULL DEFAULT 0,   -- non-KYC floor per txn
  max_txn_nonkyc_paise    BIGINT NOT NULL DEFAULT 0,   -- non-KYC cap per txn (0 = none)
  payout_require_kyc      BOOLEAN NOT NULL DEFAULT false,  -- block payout unless KYC verified
  payout_require_otp      BOOLEAN NOT NULL DEFAULT false,  -- require an email OTP to pay out
  set_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
