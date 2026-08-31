/** Shared helpers for CSV + printable HTML statements / settlement reports. */

function esc(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV string from a header row + array-of-arrays. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  return lines.join('\r\n');
}

const h = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export interface StatementColumn {
  label: string;
  align?: 'left' | 'right';
}

/**
 * A branded, printable HTML statement (matches the TutiPays receipt style).
 * `rows` are pre-formatted strings; `totals` is an optional summary row.
 */
export function statementHtml(opts: {
  brand?: string;
  title: string;
  subtitle?: string;
  meta?: [string, string][];
  columns: StatementColumn[];
  rows: string[][];
  totals?: string[];
}): string {
  const brand = opts.brand ?? 'TutiPays';
  const thead = opts.columns.map((c) => `<th style="text-align:${c.align ?? 'left'}">${h(c.label)}</th>`).join('');
  const body = opts.rows.length
    ? opts.rows
        .map(
          (r) =>
            `<tr>${r.map((cell, i) => `<td style="text-align:${opts.columns[i]?.align ?? 'left'}">${h(cell)}</td>`).join('')}</tr>`,
        )
        .join('')
    : `<tr><td colspan="${opts.columns.length}" class="muted" style="text-align:center;padding:22px">No records for this period.</td></tr>`;
  const totalRow = opts.totals
    ? `<tr class="total">${opts.totals.map((c, i) => `<td style="text-align:${opts.columns[i]?.align ?? 'left'}">${h(c)}</td>`).join('')}</tr>`
    : '';
  const meta = (opts.meta ?? []).map(([k, v]) => `<div><span class="muted">${h(k)}:</span> <b>${h(v)}</b></div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(opts.title)} — ${h(brand)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap">
<style>
  :root{--brand:#3d43e0;--brand2:#6a52ff;--ink:#14162e;--muted:#6b7488;--line:#e7e9f4}
  *{box-sizing:border-box}
  body{font-family:'Plus Jakarta Sans',-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--ink);background:#eef1f8;margin:0;padding:22px 16px;-webkit-font-smoothing:antialiased}
  .sheet{max-width:960px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 10px 34px rgba(30,34,90,.10)}
  .rhead{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;padding:20px 24px;display:flex;align-items:center;gap:13px}
  .rhead .logo{width:40px;height:40px;border-radius:11px;background:rgba(255,255,255,.16);display:grid;place-items:center;font-size:21px;font-weight:800}
  .rhead h1{font-size:19px;margin:0;font-weight:800}.rhead .sub{color:#dfe0fa;font-size:12.5px;margin-top:1px}
  .body{padding:18px 24px 24px}
  .meta{display:flex;flex-wrap:wrap;gap:6px 22px;font-size:13px;margin-bottom:14px}
  .muted{color:var(--muted)} .mono,td.n{font-family:'IBM Plex Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:9px 10px;border-bottom:1px solid var(--line);background:#f7f8fb}
  td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .total td{font-weight:800;border-top:2px solid var(--line);color:var(--brand)}
  .total td:first-child{color:var(--ink)}
  .foot{color:var(--muted);font-size:11px;margin-top:14px}
  .btns{padding:0 24px 22px}
  .btn{display:inline-block;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer;border:none;border-radius:10px;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;font-family:inherit}
  @media print{body{background:#fff;padding:0}.sheet{border:none;box-shadow:none;border-radius:0}.noprint{display:none}}
</style></head><body>
  <div class="sheet">
    <div class="rhead"><div class="logo">₹</div><div><h1>${h(brand)} — ${h(opts.title)}</h1>${opts.subtitle ? `<div class="sub">${h(opts.subtitle)}</div>` : ''}</div></div>
    <div class="body">
      ${meta ? `<div class="meta">${meta}</div>` : ''}
      <div style="overflow-x:auto"><table><thead><tr>${thead}</tr></thead><tbody>${body}${totalRow}</tbody></table></div>
      <div class="foot">Generated ${h(new Date().toLocaleString('en-IN'))} · Computer-generated statement, no signature required.</div>
    </div>
    <div class="btns"><button class="btn noprint" onclick="window.print()">🖨 Print / Save as PDF</button></div>
  </div>
</body></html>`;
}
