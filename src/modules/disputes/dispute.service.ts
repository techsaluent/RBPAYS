import { query } from '../../../db';
import { sendSms } from '../notify/notify.service';

export type MessageType = 'comment' | 'status_change' | 'resolution' | 'refund';

/** Append a message/milestone to a dispute thread. */
export async function addMessage(
  disputeId: string,
  authorId: string | null,
  authorRole: string,
  type: MessageType,
  message: string,
  statusTo?: string,
): Promise<Record<string, unknown>> {
  const { rows } = await query(
    `INSERT INTO dispute_messages (dispute_id, author_id, author_role, type, message, status_to)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [disputeId, authorId, authorRole, type, message, statusTo ?? null],
  );
  return rows[0];
}

/** SMS the member who raised the dispute (best-effort). */
export async function notifyMember(disputeId: string, text: string): Promise<void> {
  const { rows } = await query<{ phone: string }>(
    `SELECT u.phone FROM disputes d JOIN users u ON u.id = d.raised_by WHERE d.id = $1`,
    [disputeId],
  );
  const phone = rows[0]?.phone;
  if (phone) await sendSms(phone, text);
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** A printable receipt for a dispute + its full thread. */
export function disputeReceiptHtml(
  d: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
  brand = 'TutiPays',
): string {
  const rows = messages
    .map(
      (m) => `<tr>
        <td>${esc(new Date(String(m.created_at)).toLocaleString('en-IN'))}</td>
        <td>${esc(m.author_role)}</td>
        <td>${esc(String(m.type).replace('_', ' '))}${m.status_to ? ' → ' + esc(m.status_to) : ''}</td>
        <td>${esc(m.message)}</td></tr>`,
    )
    .join('');
  const status = String(d.status || '');
  const statusColor = status === 'resolved' ? '#12a35a' : status === 'rejected' ? '#c5342b' : '#b0730a';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Dispute ${esc(d.ticket_no)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap">
    <style>
    :root{--brand:#3d43e0;--brand2:#6a52ff;--ink:#14162e;--muted:#6b7488;--line:#e7e9f4}
    *{box-sizing:border-box}
    body{font-family:'Plus Jakarta Sans',-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--ink);background:#eef1f8;margin:0;padding:24px 16px;-webkit-font-smoothing:antialiased}
    .sheet{max-width:760px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 10px 34px rgba(30,34,90,.10)}
    .rhead{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;padding:20px 24px;display:flex;align-items:center;gap:13px}
    .rhead .logo{width:40px;height:40px;border-radius:11px;background:rgba(255,255,255,.16);display:grid;place-items:center;font-size:21px;font-weight:800}
    .rhead h1{font-size:19px;margin:0;font-weight:800}.rhead .muted{color:#dfe0fa;font-size:12.5px;margin-top:1px}
    .body{padding:20px 24px 24px}
    .muted{color:var(--muted)} .mono{font-family:'IBM Plex Mono',ui-monospace,monospace}
    .box{background:#f7f8fb;border:1px solid var(--line);border-radius:12px;padding:16px 18px;display:grid;gap:6px;font-size:14px}
    .box b{font-weight:700}
    .chip{display:inline-block;font-weight:800;text-transform:uppercase;font-size:11px;letter-spacing:.05em;padding:3px 10px;border-radius:999px;color:${statusColor};background:color-mix(in srgb,${statusColor} 12%,transparent)}
    h3{margin:22px 0 8px;font-size:14px;font-weight:700}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
    th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
    @media print{body{background:#fff;padding:0}.sheet{border:none;box-shadow:none;border-radius:0}}
    </style></head><body>
    <div class="sheet">
      <div class="rhead"><div class="logo">₹</div>
        <div><h1>${esc(brand)} — Dispute receipt</h1>
          <div class="muted">Ticket <b class="mono">${esc(d.ticket_no)}</b> · raised ${esc(new Date(String(d.created_at)).toLocaleString('en-IN'))}</div></div></div>
      <div class="body">
        <div class="box">
          <div>Transaction ref: <b class="mono">${esc(d.reference || '—')}</b></div>
          <div>Category: <b>${esc(String(d.category || '').replace(/_/g, ' '))}</b></div>
          <div>Status: <span class="chip">${esc(d.status)}</span></div>
          ${d.resolution ? `<div>Resolution: ${esc(d.resolution)}</div>` : ''}
          <div>Complaint: ${esc(d.description)}</div>
        </div>
        <h3>Activity</h3>
        <table><thead><tr><th>When</th><th>By</th><th>Update</th><th>Note</th></tr></thead>
        <tbody>${rows || '<tr><td colspan=4 class=muted>No activity</td></tr>'}</tbody></table>
        <p class="muted" style="margin-top:20px;font-size:12px">Generated ${esc(new Date().toLocaleString('en-IN'))}. Computer-generated — no signature required.</p>
      </div>
    </div>
    </body></html>`;
}
