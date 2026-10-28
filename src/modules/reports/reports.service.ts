/** Shared helpers for CSV + XLSX + printable HTML statements / settlement reports. */

import { deflateRawSync } from 'zlib';

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

// ---------------------------------------------------------------------------
// XLSX (genuine OOXML) — zero dependencies. We build the minimal set of parts
// an .xlsx needs and pack them into a ZIP with Node's built-in zlib, so the
// file opens cleanly in Excel, LibreOffice and Google Sheets with no "repair"
// or format-mismatch warnings. Numbers stay numeric; everything else is a
// shared string so Indian text / references survive intact.
// ---------------------------------------------------------------------------

export type Cell = string | number | null | undefined;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function xe(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));
}

// A1-style column name for a 0-based index (0 -> A, 26 -> AA).
function colName(i: number): string {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/**
 * A single-sheet .xlsx workbook as a Buffer. Pass a header row and data rows;
 * cells that are finite numbers are written as numbers (right-aligned, usable
 * in formulas), all other cells as text. `sheetName` shows on the tab.
 */
export function toXlsx(headers: string[], rows: Cell[][], sheetName = 'Report'): Buffer {
  // Shared-string table: header cells + every non-numeric data cell.
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const intern = (s: string): number => {
    let idx = sharedIndex.get(s);
    if (idx === undefined) { idx = shared.length; shared.push(s); sharedIndex.set(s, idx); }
    return idx;
  };

  const isNum = (v: Cell): v is number => typeof v === 'number' && Number.isFinite(v);

  const sheetRows: string[] = [];
  const headerCells = headers
    .map((hh, c) => `<c r="${colName(c)}1" t="s" s="1"><v>${intern(String(hh ?? ''))}</v></c>`)
    .join('');
  sheetRows.push(`<row r="1">${headerCells}</row>`);

  rows.forEach((row, r) => {
    const rn = r + 2; // row 1 is the header
    const cells = row
      .map((v, c) => {
        const ref = `${colName(c)}${rn}`;
        if (isNum(v)) return `<c r="${ref}"><v>${v}</v></c>`;
        const s = v == null ? '' : String(v);
        if (s === '') return `<c r="${ref}"/>`;
        return `<c r="${ref}" t="s"><v>${intern(s)}</v></c>`;
      })
      .join('');
    sheetRows.push(`<row r="${rn}">${cells}</row>`);
  });

  const lastCol = colName(Math.max(1, headers.length) - 1);
  const dimension = `A1:${lastCol}${rows.length + 1}`;
  const safeName = (sheetName || 'Report').replace(/[\\/*?:[\]]/g, ' ').slice(0, 31) || 'Report';

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dimension}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<sheetData>${sheetRows.join('')}</sheetData>` +
    `</worksheet>`;

  const sstXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((s) => `<si><t xml:space="preserve">${xe(s)}</t></si>`).join('') +
    `</sst>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
    `<cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs>` +
    `</styleSheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xe(safeName)}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `</Types>`;

  const parts: [string, string][] = [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbookXml],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ['xl/worksheets/sheet1.xml', sheetXml],
    ['xl/styles.xml', stylesXml],
    ['xl/sharedStrings.xml', sstXml],
  ];

  return zipParts(parts);
}

/** Pack name/content parts into a ZIP archive (deflate) — the .xlsx container. */
function zipParts(parts: [string, string][]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of parts) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    const useStore = compressed.length >= data.length;
    const body = useStore ? data : compressed;
    const method = useStore ? 0 : 8; // 0 = store, 8 = deflate

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date (fixed, valid)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, nameBuf, body);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(local);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, end]);
}

/** Express helper: send an array-of-arrays as an .xlsx download. */
export function sendXlsx(
  res: { setHeader: (k: string, v: string) => void; send: (b: Buffer) => void },
  filename: string,
  headers: string[],
  rows: Cell[][],
  sheetName = 'Report',
): void {
  const buf = toXlsx(headers, rows, sheetName);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\- ]+/g, '_')}"`);
  res.send(buf);
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
  :root{--brand:#7C3AED;--brand2:#C026D3;--ink:#14162e;--muted:#6b7488;--line:#e7e9f4}
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
