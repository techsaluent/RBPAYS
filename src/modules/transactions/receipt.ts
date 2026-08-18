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

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${escapeHtml(r.receipt_no)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: 'Courier New', monospace; background:#f4f4f4; margin:0; padding:16px; }
  .receipt { max-width: 320px; margin: 0 auto; background:#fff; padding:18px 16px; border:1px solid #ddd; }
  h1 { font-size: 18px; text-align:center; margin:0 0 2px; letter-spacing:1px; }
  .sub { text-align:center; font-size:11px; color:#666; margin-bottom:10px; }
  .status { text-align:center; font-weight:bold; text-transform:uppercase; margin:6px 0 12px; color:${STATUS_COLOR[r.status] ?? '#000'}; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td { padding:3px 0; vertical-align:top; }
  td:last-child { text-align:right; }
  .divider td { border-top:1px dashed #999; padding:0; height:8px; }
  .total td { font-weight:bold; font-size:14px; border-top:1px solid #000; padding-top:6px; }
  .foot { text-align:center; font-size:10px; color:#888; margin-top:12px; }
  @media print { body { background:#fff; padding:0; } .receipt { border:none; } .noprint { display:none; } }
  .btn { display:block; width:100%; margin-top:14px; padding:10px; font-size:13px; cursor:pointer; border:1px solid #333; background:#333; color:#fff; border-radius:4px; }
</style></head>
<body>
  <div class="receipt">
    <h1>${escapeHtml(brand)}</h1>
    <div class="sub">${escapeHtml(r.service_title)} Receipt</div>
    <div class="status">${escapeHtml(r.status)}</div>
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
      ${Number(r.charge) > 0 ? money('Charge', r.charge) : ''}
      ${Number(r.commission) > 0 ? money('Commission', r.commission) : ''}
      ${taxRows ? `<tr class="divider"><td colspan="2"></td></tr>${taxRows}` : ''}
      ${money(r.direction === 'credit' ? 'Credited' : 'Net Paid', r.net_paid, true)}
    </table>
    <div class="foot">This is a computer-generated receipt.<br>Thank you for using ${escapeHtml(brand)}.</div>
    <button class="btn noprint" onclick="window.print()">Print</button>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
