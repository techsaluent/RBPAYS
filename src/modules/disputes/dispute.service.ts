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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Dispute ${esc(d.ticket_no)}</title>
    <style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a2233;max-width:720px;margin:24px auto;padding:0 16px}
    h1{font-size:20px;margin:0 0 2px}.muted{color:#6b7488}table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px}
    th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e9f2;vertical-align:top}th{color:#6b7488;font-size:12px}
    .box{background:#f7f8fb;border:1px solid #e5e9f2;border-radius:10px;padding:14px 16px;margin-top:14px}
    .tag{font-weight:700;text-transform:uppercase;font-size:11px}</style></head><body>
    <h1>${esc(brand)} — Dispute receipt</h1>
    <div class="muted">Ticket <b>${esc(d.ticket_no)}</b> · raised ${esc(new Date(String(d.created_at)).toLocaleString('en-IN'))}</div>
    <div class="box">
      <div>Transaction ref: <b>${esc(d.reference || '—')}</b></div>
      <div>Category: ${esc(String(d.category || '').replace(/_/g, ' '))}</div>
      <div>Status: <span class="tag">${esc(d.status)}</span></div>
      ${d.resolution ? `<div>Resolution: ${esc(d.resolution)}</div>` : ''}
      <div>Complaint: ${esc(d.description)}</div>
    </div>
    <h3 style="margin-top:18px;font-size:14px">Activity</h3>
    <table><thead><tr><th>When</th><th>By</th><th>Update</th><th>Note</th></tr></thead>
    <tbody>${rows || '<tr><td colspan=4 class=muted>No activity</td></tr>'}</tbody></table>
    <p class="muted" style="margin-top:20px;font-size:12px">Generated ${esc(new Date().toLocaleString('en-IN'))}. Computer-generated — no signature required.</p>
    </body></html>`;
}
