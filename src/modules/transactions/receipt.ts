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
  payment_gateway: 'Wallet Top-up',
};

/** Structured receipt payload (also used to render the printable HTML). */
export function receiptData(txn: TxnRow, detail: Detail, user: { full_name: string; phone: string }) {
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
  };
}

const STATUS_COLOR: Record<string, string> = {
  success: '#137333',
  pending: '#b06000',
  failed: '#c5221f',
  refunded: '#5f6368',
};

/** Render a compact, printable HTML receipt (58/80mm thermal friendly). */
export function receiptHtml(txn: TxnRow, detail: Detail, user: { full_name: string; phone: string }): string {
  const r = receiptData(txn, detail, user);
  const rows = Object.entries(r.details)
    .filter(([, v]) => v && v !== '-')
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
    .join('');
  const money = (label: string, value: string, strong = false) =>
    `<tr class="${strong ? 'total' : ''}"><td>${label}</td><td>₹${value}</td></tr>`;

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
    <h1>RBPAYS</h1>
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
      ${money(r.direction === 'credit' ? 'Credited' : 'Net Paid', r.net_paid, true)}
    </table>
    <div class="foot">This is a computer-generated receipt.<br>Thank you for using RBPAYS.</div>
    <button class="btn noprint" onclick="window.print()">Print</button>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
