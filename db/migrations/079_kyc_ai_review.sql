-- =====================================================================
-- AI-assisted KYC document review.
--   An AI vision model OCRs an uploaded document and records a NON-BINDING
--   recommendation (verdict + confidence + extracted fields) on the row.
--   A human reviewer still confirms approve/reject — the AI only removes the
--   OCR / data-entry work. These columns are nullable and default-empty, so
--   existing rows and the manual flow are unaffected.
-- =====================================================================

ALTER TABLE kyc_documents
  ADD COLUMN IF NOT EXISTS ai_verdict     TEXT,            -- approve | reject | uncertain
  ADD COLUMN IF NOT EXISTS ai_confidence  INTEGER,         -- 0-100
  ADD COLUMN IF NOT EXISTS ai_extracted   JSONB,           -- {name, id_number, doc_type, ...}
  ADD COLUMN IF NOT EXISTS ai_reason      TEXT,
  ADD COLUMN IF NOT EXISTS ai_reviewed_at TIMESTAMPTZ;
