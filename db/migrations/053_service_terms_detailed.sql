-- Detailed per-service Terms & Conditions.
--
-- Replaces the short 052 seed with a full, multi-point clause per service.
-- Each clause is newline-separated bullet points; the Terms page renders each
-- line as a list item. Overwrites the seeded defaults (pre-go-live); once an
-- admin edits a clause in the panel it can be re-seeded only by choice.

UPDATE site_services SET terms = v.terms FROM (VALUES
  ('recharge', $$Mobile and DTH recharges are processed in real time through the respective telecom / DTH operator; TutiPays only relays the request to the operator.
A successful recharge is final and cannot be cancelled, modified or reversed once the operator confirms it.
If a recharge fails or is rejected by the operator, the amount and any charge are auto-reversed to your wallet once the operator confirms the failure.
Plan tariff, validity and benefits are decided solely by the operator and may change without notice.
Wrong-number or wrong-plan recharges done on a customer's instruction are the retailer's responsibility and cannot be recalled by TutiPays.
Commission is credited only on successful recharges as per the applicable plan and is recovered if a transaction is later reversed.$$),
  ('aeps', $$AEPS allows a customer to withdraw cash, check balance or get a mini-statement using their Aadhaar number and biometric (fingerprint/iris) authentication; the customer's consent is mandatory for every transaction.
The retailer must be KYC-verified and use a certified biometric device. Customer Aadhaar and biometric data must never be stored, copied or reused.
Per-transaction and daily limits apply as set by the acquiring bank, NPCI and the RBI, and may change without prior notice.
Settlement of AEPS cash-out to your wallet may attract TDS under Section 194N on aggregate cash withdrawals beyond the statutory threshold.
Disputes (for example an account debited but cash not dispensed) are resolved through the acquiring bank and the NPCI dispute-resolution mechanism and timelines; TutiPays will assist in routing the complaint.
The retailer is responsible for handing the exact cash to the correct customer; TutiPays is not liable for cash handling at the counter.$$),
  ('dmt', $$Domestic Money Transfer sends funds by IMPS/NEFT to a beneficiary bank account and is provided through RBI-authorised banks/partners, with TutiPays acting only as a technology facilitator.
DMT is subject to the RBI's Domestic Money Transfer framework — currently a ceiling of Rs.5,000 per transaction and Rs.25,000 per remitter per calendar month (or as revised by the RBI).
Remitter verification/KYC as prescribed is mandatory before a transfer; the retailer must capture correct remitter and beneficiary details.
A successful transfer cannot be recalled or cancelled. If the beneficiary bank returns or fails the transfer, the amount is auto-reversed to your wallet once the return is confirmed (typically within minutes to a few working days).
Beneficiary account number and IFSC accuracy are the sender's responsibility; TutiPays is not liable for a transfer to a wrong but valid account entered by the user.
Charges and commission are as per the applicable plan and are credited only on successful transfers. Suspicious or structured transfers may be blocked under AML rules.$$),
  ('bbps', $$Bill payments are routed through the Bharat Bill Payment System (BBPS) to the biller you select.
A successful bill payment is non-refundable; failed payments are auto-reversed to your wallet as per BBPS timelines.
Posting of the payment at the biller, along with any disconnection or late fees and bill disputes, is governed by the biller.
Verify the consumer number and bill details before paying; a payment made to a wrong consumer id on a customer's instruction cannot be recalled.
Any convenience fee is displayed before you confirm the payment.
Commission is credited only on successful payments and is recovered on reversal.$$),
  ('matm', $$Micro ATM lets a customer withdraw cash using their own debit card and PIN on a certified mini-POS device; the card and PIN are entered by the customer.
Per-transaction and daily limits are set by the card-issuing bank, the acquiring bank and NPCI.
Card data and PIN must never be stored; the retailer must ensure secure, private PIN entry.
Disputes are handled through the acquiring bank and the NPCI dispute process and timelines.
The retailer is responsible for dispensing the exact cash to the cardholder only.
Settlement to your wallet follows the acquirer's schedule and may attract Section 194N TDS on aggregate cash-out.$$),
  ('aadhaar_pay', $$Aadhaar Pay collects a customer payment from the customer's Aadhaar-linked bank account using Aadhaar plus biometric authentication.
The customer's explicit biometric consent is required for each transaction; Aadhaar and biometric data must not be stored.
Limits and disputes follow the acquiring bank and NPCI rules and timelines.
A successful collection is credited to your wallet as per the acquirer's settlement; reversals follow the network process.
The retailer must deliver the goods or service for which the payment was collected.$$),
  ('payout', $$Payouts disburse funds from your wallet to a beneficiary bank account or UPI ID via IMPS/NEFT/UPI.
You must verify the beneficiary details before confirming; a successful payout cannot be reversed.
Some payouts settle asynchronously — the transaction may show "pending" while the wallet is already reserved, and is confirmed or reversed when the partner bank sends the final status.
Per-transaction and daily limits and risk checks apply and may change without notice.
A payout to wrong but valid beneficiary details entered by the user is the user's responsibility.
Charges and commission apply per the plan; failed payouts are auto-reversed to your wallet.$$),
  ('card_swipe', $$Card Swipe (mPOS) accepts a customer's debit or credit card payment on a certified device; the applicable Merchant Discount Rate (MDR) is deducted from the settled amount.
Settlement to your wallet follows the acquirer's schedule (typically T+1 or as configured).
Card-network chargebacks, fraud reversals or disputed payments may be debited back from your wallet; retain charge slips and verify customer identity where required.
Card data and PIN must never be stored; PCI-DSS handling rules apply.
Disputes are handled through the acquiring bank and card-network process.$$),
  ('cms', $$Cash Management Services let you accept cash on behalf of partner NBFCs, lenders or companies against a customer's loan or account.
Deposits are subject to the partner's cut-off times, limits and reconciliation; posting to the customer's account follows the partner's schedule.
Obtain the correct customer / loan reference before accepting cash; a wrong reference may delay posting.
Once accepted and acknowledged, a CMS deposit cannot be reversed by TutiPays; corrections follow the partner's process.
Commission is as per the partner's arrangement and the applicable plan.$$),
  ('pan_card', $$PAN new and correction applications are forwarded to NSDL / UTIITSL; TutiPays acts only as a facilitator.
Government and processing fees are non-refundable once an application is submitted.
Approval, correction and dispatch timelines, and the final decision, rest solely with the issuing authority.
The applicant is responsible for the accuracy of the documents and details submitted.
Rejections arising from incorrect or incomplete documents are not refundable.$$),
  ('travel', $$Travel bookings (flight, bus, train, hotel) are subject to the operator's fare rules, availability and terms at the time of booking.
Cancellations, date changes and refunds follow the respective operator's policy and may attract cancellation and convenience charges.
Refunds, where applicable, are credited only after the operator processes them and may take several working days.
Fares and availability are dynamic and are confirmed only on a successful booking.
TutiPays is a booking facilitator and is not liable for operator delays, cancellations or service quality.$$),
  ('insurance', $$Insurance policies are issued by the respective insurer; the policy wording, coverage, exclusions and claims are governed solely by the insurer.
Premiums are non-refundable except as per the insurer's free-look or cancellation terms.
The customer must provide accurate information; any misstatement may void the policy.
Claims are filed with and settled by the insurer; TutiPays only facilitates issuance and is not the risk carrier.
Commission is as per the insurer's arrangement and applicable regulatory limits.$$),
  ('loan', $$Loan-repayment collections are posted to the respective lender against the customer's loan account.
Verify the loan account or reference before confirming; a wrong reference may delay or mispost the payment.
Posting time at the lender and any late-fee handling are governed by the lender.
A successful, acknowledged repayment cannot be reversed by TutiPays; corrections follow the lender's process.
Commission is credited only on successful collections.$$),
  ('credit_card', $$Credit-card bill payments are posted to the respective card issuer against the card number you provide.
Verify the card number before confirming; a successful payment is non-refundable.
Posting time varies by issuer; any late-payment consequences with the issuer are the cardholder's responsibility.
Failed payments are auto-reversed to your wallet.
Commission is as per the applicable plan.$$)
) AS v(code, terms)
WHERE site_services.code = v.code;
