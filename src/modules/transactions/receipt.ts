import { paiseToRupees } from '../../utils/money';

interface TxnRow {
  id: string;
  service: string;
  direction: string;
  reference: string;
  amount_paise: string;
  charge_paise: string;
  commission_paise: string;
  net_paise: string;
  status: string;
  provider: string | null;
  created_at: string;
}

type Detail = Record<string, unknown>;

/** Service-specific "paid to / details" rows for the receipt. */
function detailRows(service: string, d: Detail): [string, string][] {
  const s = (v: unknown) => (v == null ? '-' : String(v));
  switch (service) {
    case 'dmt':
    case 'payout':
      return [
        ['Beneficiary', s(d.beneficiary_name)],
        ['Account', s(d.account_number)],
        ['IFSC', s(d.ifsc)],
        ['Mode', s(d.mode)],
        ['UTR', s(d.utr)],
      ];
    case 'bbps':
      return [
        ['Biller', s(d.biller_name ?? d.biller_id)],
        ['Category', s(d.category)],
        ['Consumer No.', s(d.consumer_number)],
      ];
    case 'recharge':
      return [
        ['Operator', s(d.operator)],
        ['Type', s(d.recharge_type)],
        ['Number', s(d.number)],
      ];
    case 'aeps':
      return [
        ['Type', s(d.txn_type)],
        ['Aadhaar', s(d.aadhaar_ref)],
        ['Bank IIN', s(d.bank_iin)],
        ['RRN', s(d.rrn)],
        ['Balance', d.balance_paise == null ? '-' : `₹${(Number(d.balance_paise) / 100).toFixed(2)}`],
      ];
    case 'cms':
      return [
        ['Biller', s(d.biller_name ?? d.agent_id)],
        ['Account', s(d.account_number)],
        ['Customer', s(d.customer_name)],
      ];
    case 'card_swipe':
      return [
        ['Card', `${s(d.card_network)} ${s(d.card_type)}`.trim()],
        ['Card No.', d.card_last4 ? `**** ${d.card_last4}` : '-'],
        ['RRN', s(d.rrn)],
        ['Terminal', s(d.tid)],
      ];
    case 'upi':
      return [['Payee VPA', s(d.vpa)], ['Payee', s(d.payee_name)], ['UTR', s(d.utr)]];
    case 'matm':
      return [['Card', `${s(d.card_network)}`.trim()], ['Card No.', d.card_last4 ? `**** ${d.card_last4}` : '-'], ['RRN', s(d.rrn)]];
    case 'aadhaar_pay':
      return [['Aadhaar', s(d.aadhaar_ref)], ['Bank IIN', s(d.bank_iin)], ['RRN', s(d.rrn)]];
    case 'pan_card':
      return [['Type', s(d.application_type)], ['Portal', s(d.portal)], ['Applicant', s(d.applicant_name)], ['Ack No.', s(d.ack_number)]];
    case 'wallet_transfer':
      return [['Note', s(d.note)]];
    case 'travel':
      return [['Type', s(d.booking_type)], ['Operator', s(d.operator)], ['Route', `${s(d.from_location)} → ${s(d.to_location)}`], ['Passenger', s(d.passenger_name)], ['PNR', s(d.pnr)]];
    case 'insurance':
      return [['Category', s(d.category)], ['Insurer', s(d.insurer)], ['Customer', s(d.customer_name)], ['Policy No.', s(d.policy_number)]];
    case 'loan':
      return [['Lender', s(d.lender)], ['Loan A/C', s(d.loan_account_no)], ['Customer', s(d.customer_name)], ['UTR', s(d.utr)]];
    case 'credit_card':
      return [['Issuer', s(d.issuer)], ['Card', s(d.card_number)], ['Customer', s(d.customer_name)], ['UTR', s(d.utr)]];
    case 'payment_gateway':
      return [['Purpose', 'Wallet top-up']];
    default:
      return [];
  }
}

const SERVICE_TITLE: Record<string, string> = {
  dmt: 'Money Transfer',
  payout: 'Payout',
  bbps: 'Bill Payment',
  recharge: 'Recharge',
  aeps: 'AEPS',
  cms: 'Cash Management',
  card_swipe: 'Card Swipe',
  upi: 'UPI Payout',
  matm: 'Micro ATM',
  aadhaar_pay: 'Aadhaar Pay',
  pan_card: 'PAN Card',
  wallet_transfer: 'Wallet Transfer',
  travel: 'Travel Booking',
  insurance: 'Insurance',
  loan: 'Loan Repayment',
  credit_card: 'Credit Card Bill',
  payment_gateway: 'Wallet Top-up',
};

export interface TaxBreakdown {
  tds?: { section: string; gross_paise: number; rate_bps: number; tds_paise: number }[];
  gst?: { base_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number } | null;
}

/** Structured receipt payload (also used to render the printable HTML). */
export function receiptData(
  txn: TxnRow,
  detail: Detail,
  user: { full_name: string; phone: string },
  tax?: TaxBreakdown,
) {
  return {
    receipt_no: txn.reference,
    transaction_id: txn.id,
    date: txn.created_at,
    service: txn.service,
    service_title: SERVICE_TITLE[txn.service] ?? txn.service,
    status: txn.status,
    provider: txn.provider,
    customer: { name: user.full_name, phone: user.phone },
    details: Object.fromEntries(detailRows(txn.service, detail)),
    amount: paiseToRupees(txn.amount_paise),
    charge: paiseToRupees(txn.charge_paise),
    commission: paiseToRupees(txn.commission_paise),
    net_paid: paiseToRupees(txn.net_paise),
    direction: txn.direction,
    tax: tax ?? {},
  };
}

const STATUS_COLOR: Record<string, string> = {
  success: '#137333',
  pending: '#b06000',
  failed: '#c5221f',
  refunded: '#5f6368',
};

/** Render a compact, printable HTML receipt (58/80mm thermal friendly). */
export function receiptHtml(
  txn: TxnRow,
  detail: Detail,
  user: { full_name: string; phone: string },
  tax?: TaxBreakdown,
  brand = 'TutiPays',
): string {
  const r = receiptData(txn, detail, user, tax);
  const rows = Object.entries(r.details)
    .filter(([, v]) => v && v !== '-')
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
    .join('');
  const money = (label: string, value: string, strong = false) =>
    `<tr class="${strong ? 'total' : ''}"><td>${label}</td><td>₹${value}</td></tr>`;
  const p = (v: number) => (v / 100).toFixed(2);
  const taxRows = [
    ...(r.tax.tds ?? []).map((t) =>
      `<tr><td>TDS (${escapeHtml(t.section)} @ ${(t.rate_bps / 100).toFixed(t.rate_bps % 100 ? 2 : 0)}%)</td><td>-₹${p(t.tds_paise)}</td></tr>`),
    ...(r.tax.gst
      ? [
          `<tr><td>Taxable value</td><td>₹${p(r.tax.gst.base_paise)}</td></tr>`,
          r.tax.gst.igst_paise > 0
            ? `<tr><td>IGST</td><td>₹${p(r.tax.gst.igst_paise)}</td></tr>`
            : `<tr><td>CGST</td><td>₹${p(r.tax.gst.cgst_paise)}</td></tr><tr><td>SGST</td><td>₹${p(r.tax.gst.sgst_paise)}</td></tr>`,
        ]
      : []),
  ].join('');

  const statusColor = STATUS_COLOR[r.status] ?? '#5b6379';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${escapeHtml(r.receipt_no)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap">
<style>
  :root { color-scheme: light; --brand:#3d43e0; --brand2:#6a52ff; --ink:#14162e; --muted:#6b7488; --line:#e7e9f4; }
  * { box-sizing: border-box; }
  body { font-family:'Plus Jakarta Sans',-apple-system,Segoe UI,Roboto,Arial,sans-serif; background:#eef1f8; margin:0; padding:18px; color:var(--ink); -webkit-font-smoothing:antialiased; }
  .receipt { max-width:350px; margin:0 auto; background:#fff; border:1px solid var(--line); border-radius:16px; overflow:hidden; box-shadow:0 10px 34px rgba(30,34,90,.10); }
  .rhead { background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; padding:18px 18px 16px; text-align:center; }
  .rhead .logo { width:38px; height:38px; border-radius:11px; background:rgba(255,255,255,.16); display:inline-grid; place-items:center; font-size:20px; font-weight:800; margin-bottom:8px; }
  .rhead h1 { font-size:19px; margin:0; font-weight:800; letter-spacing:-.01em; }
  .rhead .sub { font-size:12px; opacity:.9; margin-top:2px; }
  .chip { display:inline-block; margin-top:11px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.05em; padding:5px 13px; border-radius:999px; background:#fff; color:${statusColor}; }
  .body { padding:16px 18px 6px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  td { padding:5px 0; vertical-align:top; color:var(--ink); }
  td:first-child { color:var(--muted); font-weight:500; }
  td:last-child { text-align:right; font-weight:600; font-family:'IBM Plex Mono',ui-monospace,monospace; }
  .divider td { border-top:1px dashed var(--line); padding:0; height:9px; }
  .total td { font-weight:800; font-size:15px; border-top:2px solid var(--line); padding-top:8px; color:var(--brand); }
  .total td:first-child { color:var(--ink); }
  .credit td:last-child { color:#12a35a; }
  .charge td:last-child { color:#c5342b; }
  .foot { text-align:center; font-size:10.5px; color:var(--muted); padding:12px 18px 18px; line-height:1.5; }
  .btns { padding:0 18px 18px; }
  .btn { display:block; width:100%; padding:11px; font-size:13.5px; font-weight:700; cursor:pointer; border:none; border-radius:10px;
    background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; box-shadow:0 6px 16px rgba(61,67,224,.32); font-family:inherit; }
  @media print { body { background:#fff; padding:0; } .receipt { border:none; box-shadow:none; border-radius:0; } .noprint { display:none; } }
</style></head>
<body>
  <div class="receipt">
    <div class="rhead">
      <div class="logo">₹</div>
      <h1>${escapeHtml(brand)}</h1>
      <div class="sub">${escapeHtml(r.service_title)} Receipt</div>
      <div class="chip">${escapeHtml(r.status)}</div>
    </div>
    <div class="body">
    <table>
      <tr><td>Receipt No.</td><td>${escapeHtml(r.receipt_no)}</td></tr>
      <tr><td>Date</td><td>${new Date(r.date).toLocaleString('en-IN')}</td></tr>
      <tr><td>Customer</td><td>${escapeHtml(r.customer.name)}</td></tr>
      <tr><td>Mobile</td><td>${escapeHtml(r.customer.phone)}</td></tr>
      ${r.provider ? `<tr><td>Provider</td><td>${escapeHtml(r.provider)}</td></tr>` : ''}
      <tr class="divider"><td colspan="2"></td></tr>
      ${rows}
      <tr class="divider"><td colspan="2"></td></tr>
      ${money('Amount', r.amount)}
      ${Number(r.charge) > 0 ? `<tr class="charge"><td>Service charge</td><td>+₹${r.charge}</td></tr>` : ''}
      ${Number(r.commission) > 0 ? `<tr class="credit"><td>Commission earned</td><td>+₹${r.commission}</td></tr>` : ''}
      ${taxRows ? `<tr class="divider"><td colspan="2"></td></tr>${taxRows}` : ''}
      ${money(r.direction === 'credit' ? 'Credited' : 'Net Paid', r.net_paid, true)}
    </table>
    </div>
    <div class="foot">This is a computer-generated receipt.<br>Thank you for using ${escapeHtml(brand)}.</div>
    <div class="btns"><button class="btn noprint" onclick="window.print()">🖨 Print receipt</button></div>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
