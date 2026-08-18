/*
 * Charts — a tiny, dependency-free chart kit for the panel. Each function
 * returns an HTML/SVG string that app.js injects via innerHTML. Colours come
 * from CSS variables so the charts follow the panel theme. No build step, no
 * external libraries (the panel runs under a strict same-origin setup).
 */
const Charts = (() => {
  const money = (p) => '₹' + Number(p / 100 || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

  // Smooth-ish area + line chart of a numeric series.
  // series: [{ day:'YYYY-MM-DD', value:Number }]; fmt formats the hover value.
  function area(series, opts = {}) {
    const fmt = opts.fmt || (v => v);
    const W = 620, H = 190, padL = 8, padR = 8, padT = 14, padB = 26;
    const n = series.length;
    if (!n) return '<div class="muted" style="padding:20px">No data yet.</div>';
    const max = Math.max(1, ...series.map(s => s.value));
    const iw = W - padL - padR, ih = H - padT - padB;
    const x = i => padL + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const y = v => padT + ih - (v / max) * ih;
    const pts = series.map((s, i) => [x(i), y(s.value)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const areaPath = `${line} L ${x(n - 1).toFixed(1)} ${padT + ih} L ${x(0).toFixed(1)} ${padT + ih} Z`;
    // Gridlines + right-edge value labels at 0 / 50 / 100%.
    const grid = [0, 0.5, 1].map(f => {
      const yy = padT + ih - f * ih;
      return `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}"
        stroke="var(--line)" stroke-width="1" />
        <text x="${W - padR}" y="${(yy - 3).toFixed(1)}" text-anchor="end"
        font-size="10" fill="var(--muted)">${esc(fmt(max * f))}</text>`;
    }).join('');
    const dots = pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}"
      r="${i === n - 1 ? 4 : 2.5}" fill="var(--brand)"><title>${esc(series[i].day)}: ${esc(fmt(series[i].value))}</title></circle>`).join('');
    // A few date ticks along the X axis.
    const ticks = series.map((s, i) => {
      if (n > 8 && i % Math.ceil(n / 7) !== 0 && i !== n - 1) return '';
      const d = s.day.slice(5); // MM-DD
      return `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(d)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="display:block;max-height:210px">
      <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--brand)" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="var(--brand)" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path d="${areaPath}" fill="url(#cg)"/>
      <path d="${line}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}${ticks}
    </svg>`;
  }

  // Horizontal bars — items: [{ label, value }]; fmt formats the value label.
  function hbars(items, opts = {}) {
    const fmt = opts.fmt || (v => v);
    const rows = items.filter(i => i.value > 0);
    if (!rows.length) return '<div class="muted" style="padding:16px">No data yet.</div>';
    const max = Math.max(...rows.map(i => i.value));
    return `<div style="display:flex;flex-direction:column;gap:10px">` + rows.map(i => `
      <div style="display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center;font-size:13px">
        <span style="color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(i.label)}</span>
        <span style="background:var(--line);border-radius:6px;height:12px;overflow:hidden">
          <span style="display:block;height:100%;width:${Math.max(3, (i.value / max) * 100).toFixed(1)}%;
            background:linear-gradient(90deg,var(--brand),color-mix(in srgb,var(--brand) 60%,#7c3aed));border-radius:6px"></span>
        </span>
        <b style="font-variant-numeric:tabular-nums;white-space:nowrap">${esc(fmt(i.value))}</b>
      </div>`).join('') + `</div>`;
  }

  // Donut for a small set of segments — [{label, value, color}].
  function donut(segments, opts = {}) {
    const total = segments.reduce((s, x) => s + x.value, 0);
    if (!total) return '<div class="muted" style="padding:16px">No data yet.</div>';
    const R = 60, C = 2 * Math.PI * R, cx = 80, cy = 80;
    let off = 0;
    const arcs = segments.map(s => {
      const frac = s.value / total;
      const dash = `${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}`;
      const seg = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="20"
        stroke-dasharray="${dash}" stroke-dashoffset="${(-off * C).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${esc(s.label)}: ${s.value}</title></circle>`;
      off += frac;
      return seg;
    }).join('');
    const legend = segments.map(s => `<div style="display:flex;align-items:center;gap:8px;font-size:13px;margin:4px 0">
      <span style="width:11px;height:11px;border-radius:3px;background:${s.color};display:inline-block"></span>
      <span style="color:var(--muted)">${esc(s.label)}</span>
      <b style="margin-left:auto;font-variant-numeric:tabular-nums">${s.value}</b></div>`).join('');
    return `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <svg viewBox="0 0 160 160" width="150" height="150" style="flex:none">${arcs}
        <text x="80" y="76" text-anchor="middle" font-size="13" fill="var(--muted)">Total</text>
        <text x="80" y="96" text-anchor="middle" font-size="22" font-weight="700" fill="var(--ink)">${total}</text>
      </svg>
      <div style="flex:1;min-width:160px">${legend}</div></div>`;
  }

  return { area, hbars, donut, money };
})();
