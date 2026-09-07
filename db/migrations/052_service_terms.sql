-- Per-service Terms & Conditions text, so each service carries its own clause.
--
-- The public Terms page renders a "Service-specific terms" section from the
-- ENABLED + visible services (GET /api/v1/site/services). Disabling a service
-- in the admin Services desk therefore removes its terms clause from the site
-- automatically, alongside its home-page card — one master switch per service.

ALTER TABLE site_services ADD COLUMN IF NOT EXISTS terms TEXT NOT NULL DEFAULT '';

-- Seed a proper clause for each seeded service (only where still blank, so an
-- admin's edits are never overwritten on a re-run).
UPDATE site_services SET terms = v.terms FROM (VALUES
  ('recharge',    'Mobile and DTH recharges are processed in real time through the respective operator. A successful recharge is final and cannot be cancelled or reversed. Operator-side failures are auto-reversed to your wallet. Plan validity, benefits and related disputes are governed by the operator.'),
  ('aeps',        'Aadhaar Enabled Payment System withdrawals require the customer''s Aadhaar number and biometric consent for each transaction. Per-RBI and acquiring-bank limits and daily caps apply. Disputes are settled through the acquiring bank and the NPCI dispute-resolution mechanism and timelines.'),
  ('dmt',         'Domestic Money Transfer (IMPS/NEFT) is subject to RBI''s Domestic Money Transfer framework — currently a ceiling of ₹5,000 per transaction and ₹25,000 per remitter per calendar month (or as revised by the RBI). Remitter verification is mandatory. A successful transfer cannot be recalled; returned or failed transfers are auto-reversed once the beneficiary bank confirms.'),
  ('bbps',        'Bill payments are processed over the Bharat Bill Payment System (BBPS). A successful payment is non-refundable; failed payments are reversed as per BBPS timelines. Posting of the payment at the biller and any late fees or disputes are governed by the biller.'),
  ('matm',        'Micro ATM card withdrawals require the customer''s card and PIN and are authorised by the card-issuing and acquiring banks. Disputes are handled through the acquiring bank and the NPCI dispute mechanism.'),
  ('aadhaar_pay', 'Aadhaar Pay collects customer payments using the customer''s Aadhaar and biometric authentication. The customer''s explicit consent is required for every transaction. Limits and disputes follow the acquiring bank and NPCI rules.'),
  ('payout',      'Payouts and UPI transfers disburse funds to a beneficiary bank account or UPI ID. You are responsible for verifying beneficiary details before confirming; a successful payout cannot be reversed. Asynchronous payouts may remain pending until the partner bank confirms the final status.'),
  ('card_swipe',  'Card Swipe (mPOS) accepts debit and credit card payments; the applicable Merchant Discount Rate (MDR) is deducted. Card-network chargebacks, fraud reversals or disputed payments may be debited from your wallet. You must verify customer identity where required.'),
  ('cms',         'Cash Management Services collect cash on behalf of partner NBFCs and lenders, subject to the partner''s terms, cut-off times and reconciliation. Deposited amounts are settled as per the partner''s schedule.'),
  ('pan_card',    'PAN card applications are forwarded to NSDL / UTIITSL. Government and processing fees are non-refundable once an application is submitted. Approval, correction and dispatch timelines are governed by the issuing authority.'),
  ('travel',      'Travel bookings (flight, bus, train, hotel) are subject to the operator''s fare rules, availability, cancellation and refund policy. Any cancellation charges levied by the operator apply. TutiPays is a booking facilitator.'),
  ('insurance',   'Insurance policies are issued by the respective insurer and are governed by that insurer''s policy terms, exclusions and claim process. TutiPays acts only as a facilitator and is not the insurer.'),
  ('loan',        'Loan-repayment collections are posted to the respective lender. You must verify the loan account details before confirming a payment. Posting time at the lender and any late-fee handling are governed by the lender.'),
  ('credit_card', 'Credit-card bill payments are posted to the respective card issuer. Posting times vary by issuer; a successful payment is non-refundable. Verify the card number before confirming.')
) AS v(code, terms)
WHERE site_services.code = v.code AND site_services.terms = '';
