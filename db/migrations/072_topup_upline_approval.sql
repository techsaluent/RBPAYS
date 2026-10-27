-- Add-money (wallet top-up) can now be approved by the member's UPLINE as well
-- as by admin. Upline approval is a float transfer (debit the upline's wallet,
-- credit the member); admin approval credits from the platform as before.
--
-- approval_mode records which path approved it. reviewed_by already stores the
-- approver. The receipt stays in proof_url (now also populated by file upload).

ALTER TABLE wallet_topup_requests
  ADD COLUMN IF NOT EXISTS approval_mode TEXT CHECK (approval_mode IN ('admin','upline'));

-- Index to list a member's pending requests awaiting their upline's action.
CREATE INDEX IF NOT EXISTS topup_pending_idx ON wallet_topup_requests (status, created_at DESC)
  WHERE status = 'pending';
