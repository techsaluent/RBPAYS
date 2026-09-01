/* TutiPays Panel — talks to the TutiPays API. Pure vanilla JS, no build step. */

// ------- Config: point this at your API. Override via ?api= or window.TUTIPAYS_API -------
// Auto-selects the API by the domain the panel is served from.
function defaultApiBase() {
  const q = new URLSearchParams(location.search).get('api');
  if (q) return q;
  if (window.TUTIPAYS_API || window.RBPAYS_API) return window.TUTIPAYS_API || window.RBPAYS_API;
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return 'http://localhost:8080/api/v1';
  // Same-origin, path-based: the site proxies /api -> the API app.
  // e.g. panel at tutipays.com/panel calls tutipays.com/api/v1 (no CORS needed).
  return location.origin + '/api/v1';
}
const Cfg = { API: defaultApiBase() };

const State = {
  token: localStorage.getItem('rb_token') || '',
  refresh: localStorage.getItem('rb_refresh') || '',
  user: null,
};

// Super-admin portal: served from a separate URL (e.g. tutipays.com/admin) so
// the partner/retailer panel and the admin console never share a login page.
// Detected from the path (…/admin) or an explicit ?portal=admin flag / global.
const ADMIN_PORTAL = window.ADMIN_PORTAL === true
  || new URLSearchParams(location.search).get('portal') === 'admin'
  || /\/admin\/?$/.test(location.pathname);

const MEMBER_ROLES = ['retailer', 'distributor', 'master_distributor'];
const money = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
// Condense a User-Agent string to something recognisable in the sessions list.
const uaShort = (ua) => {
  if (!ua) return 'Unknown device';
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Mac OS X|Macintosh/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '';
  const br = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : /curl|PostmanRuntime|okhttp|Dart|python|node/i.test(ua) ? 'API client' : 'Browser';
  return [br, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
};
// SLA badge for a dispute row (terminal disputes show nothing).
const slaBadge = (x) => {
  if (x.status === 'resolved' || x.status === 'rejected') return '<span class="muted">—</span>';
  const h = x.sla_hours_left;
  if (h == null) return '<span class="muted">—</span>';
  if (h < 0) return `<span class="tag" style="background:#fce8e6;color:#c5221f">⏰ ${Math.abs(Math.round(h*10)/10)}h overdue</span>`;
  if (h < 2) return `<span class="tag" style="background:#fef7e0;color:#b26a00">due in ${Math.round(h*10)/10}h</span>`;
  return `<span class="tag">due in ${Math.round(h)}h</span>`;
};
// Financial-year <option>s (current + 3 prior), value = FY start year.
const taxFyOptions = () => {
  const now = new Date();
  const cur = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  let o = '';
  for (let y = cur; y >= cur - 3; y--) o += `<option value="${y}">FY ${y}-${String(y + 1).slice(-2)}</option>`;
  return o;
};
// Inline From/To date inputs (ids <pfx>_from / <pfx>_to) for use with Actions._range.
const _rangeCtl = (pfx) => `<div class="row" style="gap:6px;align-items:end">
  <div class="field" style="margin:0"><label>From</label><input id="${pfx}_from" type="date"></div>
  <div class="field" style="margin:0"><label>To</label><input id="${pfx}_to" type="date"></div></div>`;

// Dependency-free SVG bar chart. values: number[]; labels: string[] (optional).
// fmt formats the tooltip value. Renders a responsive, theme-friendly chart.
const barChart = (values, labels, fmt) => {
  const W = 720, H = 180, pad = 24, n = values.length || 1;
  const max = Math.max(1, ...values);
  const bw = (W - pad * 2) / n;
  const f = fmt || (v => v);
  const bars = values.map((v, i) => {
    const h = Math.round((v / max) * (H - pad * 2));
    const x = pad + i * bw, y = H - pad - h;
    const lbl = labels && labels[i] ? labels[i] : '';
    return `<rect x="${x + bw * 0.15}" y="${y}" width="${bw * 0.7}" height="${h}" rx="2" fill="#3d43e0" opacity="0.85">
      <title>${esc(lbl)}: ${esc(f(v))}</title></rect>`;
  }).join('');
  // sparse x labels (first, mid, last)
  const tick = (i) => labels && labels[i] ? `<text x="${pad + i * bw + bw / 2}" y="${H - 6}" font-size="10" fill="#6b7488" text-anchor="middle">${esc(labels[i])}</text>` : '';
  const ticks = n > 2 ? tick(0) + tick(Math.floor(n / 2)) + tick(n - 1) : values.map((_, i) => tick(i)).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#e7e9f4"/>
    ${bars}${ticks}</svg>`;
};
const $ = (id) => document.getElementById(id);

// ---------------- API client ----------------
const Api = {
  async raw(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && State.token) headers.Authorization = 'Bearer ' + State.token;
    const res = await fetch(Cfg.API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return res;
  },
  async call(path, opts = {}) {
    let res = await this.raw(path, opts);
    if (res.status === 401 && State.refresh && opts.auth !== false && !opts._retried) {
      if (await Auth.tryRefresh()) return this.call(path, { ...opts, _retried: true });
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = new Error(data?.error?.message || ('HTTP ' + res.status));
      e.code = data?.error?.code; e.status = res.status;
      throw e;
    }
    return data;
  },
  get(p) { return this.call(p); },
  post(p, body, auth = true) { return this.call(p, { method: 'POST', body, auth }); },
  patch(p, body) { return this.call(p, { method: 'PATCH', body }); },
  put(p, body) { return this.call(p, { method: 'PUT', body }); },
  del(p) { return this.call(p, { method: 'DELETE' }); },
};

// ---------------- Auth ----------------
const Auth = {
  async login(e) {
    e.preventDefault();
    const f = e.target;
    const body = { identifier: f.identifier.value.trim(), password: f.password.value };
    if (f.mpin && f.mpin.value.trim()) body.mpin = f.mpin.value.trim();
    if (f.totp && f.totp.value.trim()) body.totp = f.totp.value.trim();
    try {
      const d = await Api.post('/auth/login', body, false);
      // Keep the two portals separate: the admin console (super admin + staff)
      // only via the admin URL, partners only via the main panel.
      const isConsole = d.user.role === 'admin' || d.user.role === 'staff';
      if (ADMIN_PORTAL && !isConsole) {
        Auth.wipe();
        UI.authMsg('This is the administrator console. Partners, please log in at the main panel.', 'err');
        return false;
      }
      if (!ADMIN_PORTAL && isConsole) {
        Auth.wipe();
        $('auth-msg').innerHTML = `<div class="msg err">Administrators &amp; staff sign in at the admin console.
          <a href="admin.html" style="font-weight:600;text-decoration:underline">Open admin console →</a></div>`;
        return false;
      }
      Auth.save(d); await App.boot();
    } catch (err) {
      if (err.code === 'mpin_required') {
        $('mpin-field').classList.remove('hidden');
        $('mpin-field').querySelector('input').focus();
        UI.authMsg('Enter your MPIN to continue.', 'ok');
      } else if (err.code === 'totp_required') {
        $('totp-field').classList.remove('hidden');
        $('totp-field').querySelector('input').focus();
        UI.authMsg('Enter the 6-digit code from your authenticator app.', 'ok');
      } else if (err.code === 'account_locked') {
        UI.authMsg(err.message, 'err');
      } else { UI.authMsg(err.message, 'err'); }
    }
    return false;
  },
  async sendSignupOtp() {
    const f = $('signup-form');
    const phone = f.phone.value.trim();
    const msg = $('signup-otp-msg');
    if (!/^[6-9]\d{9}$/.test(phone)) { msg.innerHTML = '<span style="color:#c5221f">Enter a valid 10-digit mobile first.</span>'; return; }
    msg.textContent = 'Sending OTP…';
    try {
      const r = await Api.post('/auth/signup/request-otp', { phone, email: f.email.value.trim() || undefined }, false);
      let t = r.delivered ? 'OTP sent to your mobile.' : 'OTP generated. If SMS is not configured, ask the admin for the code.';
      if (r.dev_code) t += ` (Test code: ${r.dev_code})`;
      msg.innerHTML = `<span style="color:#137333">${esc(t)}</span>`;
    } catch (err) { msg.innerHTML = `<span style="color:#c5221f">${esc(err.message)}</span>`; }
  },
  async forgotPassword() {
    const id = prompt('Enter your registered email, phone or username:');
    if (!id) return false;
    try {
      const r = await Api.post('/auth/forgot-password', { identifier: id.trim() }, false);
      let msg = r.message || 'Reset code sent.';
      if (r.dev_code) msg += `\n\n(Test code: ${r.dev_code})`;
      const code = prompt(msg + '\n\nEnter the 6-digit reset code:');
      if (!code) return false;
      const pw = prompt('Enter your new password (min 8 characters):');
      if (!pw) return false;
      await Api.post('/auth/reset-password', { identifier: id.trim(), code: code.trim(), new_password: pw }, false);
      UI.authMsg('Password updated. Please log in.', 'ok');
    } catch (err) { UI.authMsg(err.message, 'err'); }
    return false;
  },
  async signup(e) {
    e.preventDefault();
    const f = e.target;
    const body = { full_name: f.full_name.value.trim(), email: f.email.value.trim(),
      phone: f.phone.value.trim(), password: f.password.value, role: f.role.value };
    if (f.username.value.trim()) body.username = f.username.value.trim();
    if (f.sponsor.value.trim()) body.sponsor = f.sponsor.value.trim();
    if (f.otp && f.otp.value.trim()) body.otp = f.otp.value.trim();
    try {
      const d = await Api.post('/auth/signup', body, false);
      Auth.save(d); await App.boot();
    } catch (err) { UI.authMsg(err.message, 'err'); }
    return false;
  },
  save(d) {
    State.token = d.access_token; State.refresh = d.refresh_token; State.user = d.user;
    localStorage.setItem('rb_token', d.access_token);
    localStorage.setItem('rb_refresh', d.refresh_token || '');
  },
  async tryRefresh() {
    try {
      const d = await Api.post('/auth/refresh', { refresh_token: State.refresh }, false);
      Auth.save(d); return true;
    } catch { Auth.logout(); return false; }
  },
  // Clear any stored session without touching the (already-visible) auth screen.
  wipe() {
    State.token = State.refresh = ''; State.user = null;
    localStorage.removeItem('rb_token'); localStorage.removeItem('rb_refresh');
  },
  logout() {
    State.token = State.refresh = ''; State.user = null;
    localStorage.removeItem('rb_token'); localStorage.removeItem('rb_refresh');
    $('app').style.display = 'none'; $('auth').style.display = 'grid';
  },
};

// ---------------- UI helpers ----------------
const UI = {
  authTab(which) {
    $('tab-login').classList.toggle('on', which === 'login');
    $('tab-signup').classList.toggle('on', which === 'signup');
    $('login-form').classList.toggle('hidden', which !== 'login');
    $('signup-form').classList.toggle('hidden', which !== 'signup');
    $('auth-msg').innerHTML = '';
  },
  authMsg(m, kind) { $('auth-msg').innerHTML = `<div class="msg ${kind}">${esc(m)}</div>`; },
  toast(m, kind = 'ok') {
    const v = $('view');
    const n = document.createElement('div');
    n.className = `msg ${kind}`; n.textContent = m; n.style.position = 'sticky'; n.style.top = '0';
    v.prepend(n); setTimeout(() => n.remove(), 4000);
  },
  modal(html) {
    $('modal-root').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)UI.closeModal()"><div class="modal">${html}</div></div>`;
  },
  closeModal() { $('modal-root').innerHTML = ''; },
  statusTag(s) { return `<span class="tag ${esc(s)}">${esc(s)}</span>`; },
  // A single statistic tile: colour class, icon, label, big value, sub-line.
  stat(cls, ico, label, value, sub) {
    return `<div class="stat ${cls}"><div class="ico">${ico}</div>
      <div class="k">${esc(label)}</div><div class="v">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  },
};

// ---------------- Navigation ----------------
// Only retailers (and plain users) transact; distributors/MDs manage their
// network; admin runs the platform.
const TXN_ROLES = ['retailer', 'user'];
const MGMT_ROLES = ['distributor', 'master_distributor'];
const NETWORK_ROLES = ['retailer', 'user', 'distributor', 'master_distributor'];
const NAV = [
  { key: 'dashboard', label: 'Dashboard', roles: '*' },
  { key: 'new', label: 'New Transaction', roles: TXN_ROLES },
  { key: 'beneficiaries', label: 'Beneficiaries', roles: TXN_ROLES },
  { key: 'devices', label: 'My Devices', roles: TXN_ROLES },
  { key: 'wallet', label: 'Wallet', roles: NETWORK_ROLES },
  { key: 'addmoney', label: 'Add Money', roles: NETWORK_ROLES },
  { key: 'txns', label: 'Transactions', roles: NETWORK_ROLES },
  { key: 'myearnings', label: 'My Earnings', roles: NETWORK_ROLES },
  { key: 'mydisputes', label: 'My Disputes', roles: NETWORK_ROLES },
  { key: 'network', label: 'My Network', roles: MGMT_ROLES },
  { key: 'kyc', label: 'My KYC', roles: NETWORK_ROLES },
  { key: 'tax', label: 'PAN & TDS', roles: NETWORK_ROLES },
  { key: 'profile', label: 'Profile', roles: '*' },
  { key: 'security', label: 'Security', roles: '*' },
  // Admin console — grouped into sidebar sections; each maps to a staff permission.
  { key: 'analytics', label: '📊 Analytics', roles: ['admin', 'staff'], section: 'Users & KYC' },
  { key: 'members', label: 'Users', roles: ['admin', 'staff'], perm: 'users.view', section: 'Users & KYC' },
  { key: 'kycreview', label: 'KYC Review', roles: ['admin', 'staff'], perm: 'kyc.review', section: 'Users & KYC' },
  { key: 'topupreview', label: 'Top-up Requests', roles: ['admin', 'staff'], perm: 'topup.manage', section: 'Finance' },
  { key: 'withdrawals', label: 'Withdrawals', roles: ['admin', 'staff'], perm: 'payouts.manage', section: 'Finance' },
  { key: 'bankaccounts', label: 'Bank Accounts', roles: ['admin', 'staff'], perm: 'topup.manage', section: 'Finance' },
  { key: 'plans', label: 'Commission', roles: ['admin', 'staff'], perm: 'commission.manage', section: 'Finance' },
  { key: 'taxdesk', label: 'Tax (TDS/GST)', roles: ['admin', 'staff'], perm: 'tax.manage', section: 'Finance' },
  { key: 'recon', label: 'Reconciliation', roles: ['admin', 'staff'], perm: 'recon.manage', section: 'Finance' },
  { key: 'settlement', label: 'Settlement Report', roles: ['admin', 'staff'], perm: 'recon.manage', section: 'Finance' },
  { key: 'batchpayout', label: 'Batch Payouts', roles: ['admin', 'staff'], perm: 'payouts.manage', section: 'Finance' },
  { key: 'treasury', label: 'Treasury', roles: ['admin', 'staff'], perm: 'payouts.manage', section: 'Finance' },
  { key: 'adminservices', label: 'Services', roles: ['admin', 'staff'], perm: 'providers.manage', section: 'API & Providers' },
  { key: 'providers', label: 'Providers', roles: ['admin', 'staff'], perm: 'providers.manage', section: 'API & Providers' },
  { key: 'catalog', label: 'Operator & Biller Catalog', roles: ['admin', 'staff'], perm: 'providers.manage', section: 'API & Providers' },
  { key: 'integrations', label: 'Integrations', roles: ['admin', 'staff'], perm: 'integrations.manage', section: 'API & Providers' },
  { key: 'webhooks', label: 'Webhook Log', roles: ['admin', 'staff'], perm: 'integrations.manage', section: 'API & Providers' },
  { key: 'aistudio', label: '🤖 AI Integration Studio', roles: ['admin', 'staff'], perm: 'providers.manage', section: 'API & Providers' },
  { key: 'devdesk', label: '🛠️ AI Dev Desk', roles: ['admin', 'staff'], perm: 'devdesk.manage', section: 'API & Providers' },
  { key: 'risk', label: 'Risk & AML', roles: ['admin', 'staff'], perm: 'risk.manage', section: 'Risk & Ops' },
  { key: 'opsdesk', label: 'Ops Desk', roles: ['admin', 'staff'], perm: 'ledger.view', section: 'Risk & Ops' },
  { key: 'ledger', label: 'Ledger', roles: ['admin', 'staff'], perm: 'ledger.view', section: 'Risk & Ops' },
  { key: 'disputes', label: 'Disputes', roles: ['admin', 'staff'], perm: 'disputes.manage', section: 'Risk & Ops' },
  { key: 'audit', label: 'Audit Log', roles: ['admin'], section: 'Risk & Ops' },
  { key: 'website', label: 'Website', roles: ['admin', 'staff'], perm: 'website.manage', section: 'Settings' },
  { key: 'staff', label: 'Staff & Roles', roles: ['admin'], section: 'Settings' },
];
// Super admin sees everything; staff see console items only for permissions they hold.
function hasPerm(p) {
  const perms = State.user.permissions || [];
  return perms.includes('*') || perms.includes(p);
}
function allowed(item) {
  if (item.roles === '*') return true;
  if (!item.roles.includes(State.user.role)) return false;
  if (item.perm && State.user.role === 'staff') return hasPerm(item.perm);
  return true;
}

// ---------------- App bootstrap + router ----------------
const App = {
  async applyBranding() {
    try {
      const r = await fetch(Cfg.API + '/site/settings', { cache: 'no-store' });
      if (!r.ok) return;
      const { settings: s } = await r.json();
      if (!s) return;
      App._site = s;
      // Reveal the mobile-OTP step on sign-up when the admin requires it.
      const otpBox = document.getElementById('signup-otp');
      if (otpBox) otpBox.classList.toggle('hidden', s.security_require_signup_otp !== 'true');
      if (s.primary_color) document.documentElement.style.setProperty('--brand', s.primary_color);
      const brand = s.brand_name || 'TutiPays';
      document.querySelectorAll('.brand').forEach(el => {
        const a = el.querySelector('a');
        if (a) a.textContent = brand;
        else if (el.querySelector('small')) el.childNodes[0].nodeValue = brand + ' ';
        else el.textContent = brand;
      });
      if (/TutiPays/.test(document.title)) document.title = document.title.replace(/TutiPays/g, brand);
      // Login/signup offer poster (super-admin configurable).
      const poster = document.getElementById('auth-poster');
      if (poster) {
        if (s.auth_poster_url) poster.style.backgroundImage = `url("${s.auth_poster_url}")`;
        const t = document.getElementById('poster-title');
        const sub = document.getElementById('poster-sub');
        if (t && s.auth_poster_title) t.textContent = s.auth_poster_title;
        if (sub && s.auth_poster_subtitle) sub.textContent = s.auth_poster_subtitle;
        poster.setAttribute('href', s.auth_poster_link || '../');
        if (!s.auth_poster_link) poster.removeAttribute('href');
      }
    } catch (_) {}
  },
  async boot() {
    try {
      // Always refresh from /me so staff/admin carry their live permission set.
      const me = await Api.get('/auth/me'); State.user = me.user;
    } catch { return Auth.logout(); }
    // Enforce the portal/role split on a restored session too (console = admin + staff).
    const isConsole = State.user.role === 'admin' || State.user.role === 'staff';
    if ((ADMIN_PORTAL && !isConsole) || (!ADMIN_PORTAL && isConsole)) {
      Auth.wipe();
      if (ADMIN_PORTAL) {
        UI.authMsg('This is the administrator console. Partners, please log in at the main panel.', 'err');
      } else {
        $('auth-msg').innerHTML = `<div class="msg err">Administrators &amp; staff sign in at the admin console.
          <a href="admin.html" style="font-weight:600;text-decoration:underline">Open admin console →</a></div>`;
      }
      return;
    }
    App.applyBranding();
    $('auth').style.display = 'none'; $('app').style.display = 'grid';
    $('who-name').textContent = State.user.full_name;
    $('who-role').textContent = State.user.role.replace(/_/g, ' ');
    // Render nav, inserting a section header whenever the group changes.
    let lastSection = null;
    $('nav').innerHTML = NAV.filter(allowed).map(i => {
      let head = '';
      if (i.section && i.section !== lastSection) { head = `<div class="nav-sec">${esc(i.section)}</div>`; lastSection = i.section; }
      else if (!i.section) lastSection = null;
      return `${head}<a href="#/${i.key}" data-k="${i.key}">${i.label}</a>`;
    }).join('');
    await App.refreshWallet();
    window.onhashchange = App.route;
    if (!location.hash) location.hash = '#/dashboard';
    App.route();
  },
  async refreshWallet() {
    try { const w = await Api.get('/wallet'); $('wallet-pill').textContent = money(w.wallet.balance); }
    catch { $('wallet-pill').textContent = '—'; }
  },
  route() {
    const key = (location.hash.replace('#/', '') || 'dashboard');
    const item = NAV.find(i => i.key === key) || NAV[0];
    if (!allowed(item)) return location.hash = '#/dashboard';
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.k === item.key));
    $('page-title').textContent = item.label;
    $('view').innerHTML = '<div class="muted">Loading…</div>';
    (Screens[item.key] || (() => {}))();
  },
};

// ---------------- Screens ----------------
const Screens = {
  async dashboard() {
    if (State.user.role === 'staff') {
      // Staff see a focused console: only the sections they're granted.
      const items = NAV.filter(i => i.roles !== '*' && i.roles.includes('staff') && allowed(i) && i.key !== 'dashboard');
      const links = items.map(i => `<a class="stat b" href="#/${i.key}" style="text-decoration:none;color:inherit">
        <div class="ico">▸</div><div class="k">Console</div><div class="v" style="font-size:18px">${esc(i.label)}</div></a>`).join('');
      let kycTile = '';
      if (hasPerm('kyc.review')) {
        const p = await Api.get('/kyc/pending').catch(() => ({ items: [] }));
        kycTile = UI.stat('o', '🪪', 'Pending KYC', (p.items || []).length, '<a href="#/kycreview">Review now →</a>');
      }
      $('view').innerHTML = `
        <div class="panel"><h2>Welcome, ${esc(State.user.full_name)}</h2>
          <p class="muted">You're signed in as <b>staff</b>. You can access the sections granted to you below.</p></div>
        <div class="stats mt">${kycTile}${links || '<div class="muted">No sections assigned yet. Ask the super admin to grant permissions.</div>'}</div>`;
      return;
    }
    if (State.user.role === 'admin') {
      const d = await Api.get('/admin/dashboard');
      const roles = Object.entries(d.users_by_role || {}).map(([k, n]) => `${k.replace(/_/g,' ')}: <b>${n}</b>`).join(' &nbsp; ');
      const volEntries = Object.entries(d.service_volumes || {})
        .sort((a, b) => b[1].success_amount_paise - a[1].success_amount_paise);
      const vol = volEntries.map(([k, v]) =>
        `<tr><td>${esc(k.replace(/_/g,' '))}</td><td class="right">${v.success_count}</td><td class="right">${v.total_count ?? '—'}</td><td class="right">${money(v.success_amount_paise/100)}</td></tr>`).join('');
      const trend = (d.daily || []).map(x => ({ day: x.day, value: x.amount_paise }));
      const topSvc = volEntries.slice(0, 7).map(([k, v]) => ({ label: k.replace(/_/g,' '), value: v.success_amount_paise }));
      const statusSeg = [
        { label: 'Success', value: d.txn_success_count || 0, color: '#0f9d63' },
        { label: 'Pending', value: d.txn_pending_count || 0, color: '#bd7a00' },
        { label: 'Failed', value: d.txn_failed_count || 0, color: '#d43c3c' },
      ];
      $('view').innerHTML = `
        <div class="stats">
          ${UI.stat('b','💳','Today\'s volume', money((d.today_amount_paise||0)/100), `<b>${d.today_count||0}</b> transactions today`)}
          ${UI.stat('t','📈','This month GTV', money((d.month_amount_paise||0)/100), 'Successful value, MTD')}
          ${UI.stat('g','🏦','Wallet float', money(d.wallet_float_paise/100), 'Across all wallets')}
          ${UI.stat('p','🎯','Success rate', (d.txn_success_rate??0)+'%', `<b>${d.txn_success_count||0}</b> of ${d.txn_total_count||0} txns`)}
          ${UI.stat('o','👥','Total users', (d.total_users||0), roles || '—')}
          ${UI.stat('t','💰','Commission paid', money(d.commission_paid_paise/100), 'To the network, lifetime')}
          ${UI.stat('r','🪪','Pending KYC', d.pending_kyc, d.pending_kyc ? '<a href="#/kycreview">Review now →</a>' : 'All clear')}
          ${UI.stat('o','⏳','Pending txns', (d.txn_pending_count||0), 'Awaiting settlement')}
        </div>
        <div class="panel mt"><div class="row" style="justify-content:space-between"><h2>Transaction volume — last 14 days</h2>
          <span class="muted" style="font-size:12px">Successful ₹ per day (IST)</span></div>
          ${Charts.area(trend, { fmt: Charts.money })}</div>
        <div class="chart-2 mt">
          <div class="panel"><h2>Top services by value</h2>${Charts.hbars(topSvc, { fmt: Charts.money })}</div>
          <div class="panel"><h2>Transaction status</h2>${Charts.donut(statusSeg)}</div>
        </div>
        <div class="panel mt"><h2>Command consoles</h2>
          <div class="row" style="flex-wrap:wrap;gap:8px">
            <a class="btn sm ghost" href="#/members">Users</a>
            <a class="btn sm ghost" href="#/staff">Staff &amp; Roles</a>
            <a class="btn sm ghost" href="#/kycreview">KYC Review</a>
            <a class="btn sm ghost" href="#/topupreview">Top-up Requests</a>
            <a class="btn sm ghost" href="#/plans">Commission</a>
            <a class="btn sm ghost" href="#/providers">Providers</a>
            <a class="btn sm ghost" href="#/integrations">Integrations</a>
            <a class="btn sm ghost" href="#/website">Website</a>
            <a class="btn sm ghost" href="#/taxdesk">Tax (TDS/GST)</a>
            <a class="btn sm ghost" href="#/risk">Risk &amp; AML</a>
            <a class="btn sm ghost" href="#/recon">Reconciliation</a>
            <a class="btn sm ghost" href="#/batchpayout">Batch Payouts</a>
            <a class="btn sm ghost" href="#/treasury">Treasury</a>
            <a class="btn sm ghost" href="#/opsdesk">Ops Desk</a>
            <a class="btn sm ghost" href="#/ledger">Ledger</a>
          </div></div>
        <div class="panel mt"><h2>Service volume</h2>
          <div class="tbl-wrap"><table><thead><tr><th>Service</th><th class="right">Success</th><th class="right">Total</th><th class="right">Amount</th></tr></thead>
          <tbody>${vol || '<tr><td colspan=4 class=muted>No transactions yet</td></tr>'}</tbody></table></div></div>`;
    } else if (MGMT_ROLES.includes(State.user.role)) {
      // Distributor / Master distributor — network, earnings & downline.
      const isMD = State.user.role === 'master_distributor';
      const [p, w, st, dl] = await Promise.all([
        Api.get('/network/panel').catch(() => null),
        Api.get('/wallet'),
        Api.get('/transactions/stats/summary').catch(() => null),
        Api.get('/network/downline').catch(() => ({ items: [] })),
      ]);
      const earn = p ? p.earnings.total_paise / 100 : 0;
      const counts = p ? (p.downline_counts || {}) : {};
      const totalDown = Object.values(counts).reduce((a, n) => a + Number(n), 0);
      const wl = w.wallet;
      const avail = (wl.available_paise != null ? wl.available_paise : wl.balance_paise) / 100;
      const roleCard = (k, ico) => `<div class="mini"><span class="mi">${ico}</span>
        <div class="mm"><b>${(k).replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</b><span>${Number(counts[k]||0)} member${Number(counts[k]||0)===1?'':'s'}</span></div>
        <div class="ma">${Number(counts[k]||0)}</div></div>`;
      const recent = (p?.earnings.recent || []).map(e => `<div class="mini"><span class="mi">${svcIcon(e.service_code)}</span>
        <div class="mm"><b>${esc(svcLabel(e.service_code))}</b><span>${esc(e.level)} commission</span></div>
        <div class="ma comm-pos">${money(e.amount_paise/100)}</div></div>`).join('');
      const members = (dl.items || []).slice(0, 6).map(m => `<div class="mini"><span class="mi">${(m.role||'r')[0].toUpperCase()}</span>
        <div class="mm"><b>${esc(m.full_name || m.username || m.phone || 'Member')}</b><span>${esc((m.role||'').replace(/_/g,' '))} · ${esc(m.phone||m.email||'')}</span></div>
        <div class="ma"><small>${UI.statusTag(m.status||'active')}</small></div>`+`</div>`).join('');
      $('view').innerHTML = `
        <div class="stats">
          ${UI.stat('b','👛','Wallet balance', money(wl.balance), `Available <b>${money(avail)}</b>`)}
          ${UI.stat('g','💰','Commission earned', money(earn), 'Net of TDS, lifetime')}
          ${UI.stat('o','🧑‍🤝‍🧑','My network', totalDown, isMD ? 'Distributors & retailers' : 'Retailers')}
          ${st ? UI.stat('p','📈','This month GTV', money((st.month_amount_paise||0)/100), `<b>${st.today_count||0}</b> today`) : ''}
        </div>
        <div class="dash-cols mt">
          <div>
            ${st && st.daily ? `<div class="panel"><div class="row" style="justify-content:space-between"><h2>Network volume — last 7 days</h2>
              <span class="muted" style="font-size:12px">Successful ₹ per day</span></div>
              ${Charts.area(st.daily.map(x => ({ day: x.day, value: x.amount_paise })), { fmt: Charts.money })}</div>` : ''}
            <div class="panel mt"><div class="row" style="justify-content:space-between"><h2>My members</h2>
              <a class="btn sm" onclick="Actions.addMember(false)">＋ Add member</a></div>
              ${members || '<div class="muted" style="padding:10px 0">No members yet. Add your first '+(isMD?'distributor or retailer':'retailer')+'.</div>'}
              <a class="btn sm ghost" style="margin-top:10px" href="#/network">Manage full network →</a></div>
          </div>
          <div>
            <div class="rail-card">
              <div class="row" style="justify-content:space-between;align-items:baseline">
                <span class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.4px">Available to withdraw</span>
                <b style="font-size:20px">${money(avail)}</b></div>
              <button class="btn sm" style="width:100%;justify-content:center;margin-top:12px" onclick="Actions.withdraw()">💸 Withdraw to bank</button>
              <a class="btn sm ghost" style="width:100%;justify-content:center;margin-top:8px;box-sizing:border-box" href="#/addmoney">＋ Add money</a>
            </div>
            <div class="rail-card">
              <h2 style="margin:0 0 4px;font-size:15px">Network breakdown</h2>
              ${isMD ? roleCard('distributor','🧑‍💼') : ''}
              ${roleCard('retailer','🏪')}
              ${counts.user ? roleCard('user','👤') : ''}
            </div>
            <div class="rail-card">
              <div class="row" style="justify-content:space-between"><h2 style="margin:0 0 4px;font-size:15px">Recent commission</h2>
                <a class="muted" style="font-size:12px" href="#/network">More →</a></div>
              ${recent || '<div class="muted" style="padding:10px 0">No commission yet.</div>'}
            </div>
          </div>
        </div>`;
    } else {
      // Retailer (and plain user) — full operating dashboard.
      const [w, kyc, st, tx, dp] = await Promise.all([
        Api.get('/wallet'),
        Api.get('/kyc').catch(() => null),
        Api.get('/transactions/stats/summary').catch(() => null),
        Api.get('/transactions?limit=6').catch(() => ({ items: [] })),
        Api.get('/disputes').catch(() => ({ items: [] })),
      ]);
      const kstat = kyc?.kyc_status || State.user.kyc_status;
      const kycBanner = kstat !== 'verified'
        ? `<div class="msg ${kstat === 'rejected' ? 'err' : ''}" style="background:${kstat==='rejected'?'':'#fef7e0'};color:${kstat==='rejected'?'':'#b06000'}">
             🪪 Your KYC is <b>${esc(kstat)}</b> — verify PAN &amp; Aadhaar to lift your limit and unlock AEPS. <a href="#/kyc">Complete KYC →</a></div>` : '';
      const sw = w.sub_wallets || { settlement: '0.00', commission: '0.00' };
      const s = st || {};
      const wl = w.wallet;
      const avail = (wl.available_paise != null ? wl.available_paise : wl.balance_paise) / 100;
      const held = (wl.held_paise || 0) / 100;
      const openDisputes = (dp.items || []).filter(d => ['open','in_review'].includes(d.status)).slice(0, 4);
      $('view').innerHTML = `
        ${kycBanner}
        <div class="stats">
          ${UI.stat('b','👛','Wallet balance', money(wl.balance), `Available <b>${money(avail)}</b> · Held ${money(held)}`)}
          ${UI.stat('p','💳','Today\'s business', money((s.today_amount_paise||0)/100), `<b>${s.today_count||0}</b> transactions`)}
          ${UI.stat('g','💰','Commission', money(sw.commission), 'Sub-wallet · net of TDS')}
          ${UI.stat('o','🎯','Success rate', (s.success_rate??0)+'%', `<b>${s.success_count||0}</b> of ${s.total_count||0} today`)}
        </div>
        <div class="dash-cols mt">
          <div>
            <div class="panel"><div class="row" style="justify-content:space-between"><h2>Services</h2>
              <a class="btn sm" href="#/new">＋ New transaction</a></div>
              ${svcTiles(SERVICES.map(x => x.key))}</div>
            ${s.daily ? `<div class="panel mt"><div class="row" style="justify-content:space-between"><h2>My volume — last 7 days</h2>
              <span class="muted" style="font-size:12px">Successful ₹ per day</span></div>
              ${Charts.area(s.daily.map(x => ({ day: x.day, value: x.amount_paise })), { fmt: Charts.money })}</div>` : ''}
            <div class="panel mt"><div class="row" style="justify-content:space-between"><h2>Recent transactions</h2>
              <a class="muted" style="font-size:12px" href="#/txns">View all →</a></div>
              ${txnMiniRows(tx.items || [])}</div>
          </div>
          <div>
            <div class="rail-card">
              <div class="row" style="justify-content:space-between;align-items:baseline">
                <span class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.4px">Available to withdraw</span>
                <b style="font-size:20px">${money(avail)}</b></div>
              <button class="btn sm" style="width:100%;justify-content:center;margin-top:12px" onclick="Actions.withdraw()">💸 Withdraw to bank</button>
              <a class="btn sm ghost" style="width:100%;justify-content:center;margin-top:8px;box-sizing:border-box" href="#/addmoney">＋ Add money</a>
            </div>
            <div class="rail-card">
              <div class="row" style="justify-content:space-between"><h2 style="margin:0;font-size:15px">Commission &amp; sweep</h2></div>
              <div class="mini"><span class="mi">💰</span><div class="mm"><b>Commission wallet</b><span>Net of TDS</span></div><div class="ma comm-pos">${money(sw.commission)}</div></div>
              <div class="mini"><span class="mi">🏧</span><div class="mm"><b>AePS settlement</b><span>Pending sweep</span></div><div class="ma">${money(sw.settlement)}</div></div>
              <a class="btn sm ghost" style="width:100%;justify-content:center;margin-top:10px;box-sizing:border-box" href="#/wallet">Sweep to main wallet →</a>
            </div>
            <div class="rail-card">
              <div class="row" style="justify-content:space-between"><h2 style="margin:0 0 6px;font-size:15px">Open disputes</h2>
                <a class="muted" style="font-size:12px" href="#/mydisputes">All →</a></div>
              ${disputeMiniRows(openDisputes)}
              <button class="btn sm ghost" style="width:100%;justify-content:center;margin-top:10px;box-sizing:border-box" onclick="Actions.raiseDispute()">🎫 Raise a dispute by reference</button>
            </div>
          </div>
        </div>`;
    }
  },

  // My profile: name / email / phone (company details for admin live in Website).
  async profile() {
    const u = State.user;
    const companyNote = u.role === 'admin'
      ? `<div class="panel mt" style="max-width:520px"><h2>Company details</h2>
          <p class="muted">Your legal name, address and contacts shown on the site &amp; receipts are managed under <a href="#/website">Website settings</a>.</p></div>`
      : '';
    $('view').innerHTML = `
      <div class="panel" style="max-width:520px"><h2>My profile</h2>
        <div class="field"><label>${u.role === 'admin' ? 'Company / display name' : 'Full name'}</label><input id="pf_name" value="${esc(u.full_name||'')}"></div>
        <div class="field"><label>Email</label><input id="pf_email" type="email" value="${esc(u.email||'')}"></div>
        <div class="field"><label>Mobile (10 digit)</label><input id="pf_phone" value="${esc(u.phone||'')}"></div>
        <div class="field"><label>Role</label><input value="${esc((u.role||'').replace(/_/g,' '))}" disabled></div>
        ${u.username ? `<div class="field"><label>Username</label><input value="${esc(u.username)}" disabled></div>` : ''}
        <button class="btn" onclick="Actions.saveProfile()">Save profile</button></div>
      ${companyNote}`;
  },

  // Account security: change password, set/remove login MPIN, authenticator
  // 2FA, and active-session management.
  async security() {
    const s = await Api.get('/security').catch(() => ({ mpin_set: false, totp_enabled: false, pending: false }));
    $('view').innerHTML = `
      <div class="grid cards">
        <div class="card"><div class="k">Login MPIN (PIN)</div>
          <div class="v" style="font-size:18px">${s.mpin_set ? UI.statusTag('verified') : '<span class="tag">not set</span>'}</div></div>
        <div class="card"><div class="k">Authenticator 2FA</div>
          <div class="v" style="font-size:18px">${s.totp_enabled ? UI.statusTag('verified') : '<span class="tag">off</span>'}</div></div>
      </div>
      <div class="panel mt" style="max-width:480px"><h2>Change password</h2>
        <div class="field"><label>Current password</label><input id="cp_cur" type="password"></div>
        <div class="field"><label>New password (min 8)</label><input id="cp_new" type="password"></div>
        <button class="btn" onclick="Actions.changePassword()">Update password</button></div>
      <div class="panel mt" style="max-width:480px"><h2>Login MPIN (PIN instead of OTP)</h2>
        <p class="muted">Set a 4-6 digit PIN. Once set, it's required as a second step at every login.</p>
        <div class="field"><label>Current password</label><input id="mp_pw" type="password"></div>
        <div class="field"><label>${s.mpin_set ? 'New ' : ''}MPIN (4-6 digits)</label><input id="mp_pin" type="password" inputmode="numeric" maxlength="6"></div>
        <button class="btn" onclick="Actions.setMpin()">${s.mpin_set ? 'Change' : 'Set'} MPIN</button>
        ${s.mpin_set ? `<button class="btn ghost mt" onclick="Actions.removeMpin()">Remove MPIN</button>` : ''}</div>

      <div class="panel mt" style="max-width:480px"><h2>Authenticator app (2FA)</h2>
        ${s.totp_enabled ? `
          <p class="muted">Two-factor authentication is <b>on</b>. A 6-digit code from your authenticator app is required at every login.</p>
          <div class="field"><label>Current password (to turn off)</label><input id="tf_pw" type="password"></div>
          <button class="btn danger" onclick="Actions.disable2fa()">Disable 2FA</button>
        ` : `
          <p class="muted">Add a strong second factor using Google Authenticator, Authy, 1Password, or any TOTP app.</p>
          <div id="tf_setup"><button class="btn" onclick="Actions.start2fa()">Set up authenticator</button></div>
        `}</div>

      <div class="panel mt" style="max-width:640px"><h2>Active sessions</h2>
        <p class="muted">Devices currently signed in to your account. Revoke any you don't recognise.</p>
        <div id="sess_list" class="muted">Loading…</div>
        <button class="btn ghost mt" onclick="Actions.revokeAllSessions()">Log out of all sessions</button></div>`;
    this._loadSessions();
  },

  async _loadSessions() {
    const box = $('sess_list'); if (!box) return;
    try {
      const { sessions } = await Api.get('/security/sessions');
      if (!sessions.length) { box.innerHTML = '<span class="muted">No active sessions.</span>'; return; }
      box.innerHTML = `<table class="tbl"><thead><tr><th>Device</th><th>IP</th><th>Last used</th><th></th></tr></thead><tbody>${
        sessions.map((x) => `<tr>
          <td>${esc(uaShort(x.user_agent))}</td>
          <td>${esc(x.ip || '—')}</td>
          <td>${x.last_used_at ? new Date(x.last_used_at).toLocaleString('en-IN') : '—'}</td>
          <td style="text-align:right"><button class="btn ghost sm" onclick="Actions.revokeSession('${x.id}')">Revoke</button></td>
        </tr>`).join('')
      }</tbody></table>`;
    } catch { box.innerHTML = '<span class="muted">Could not load sessions.</span>'; }
  },

  // Member self-service KYC: submit documents and see status.
  async kyc() {
    const [d, reqs] = await Promise.all([
      Api.get('/kyc').catch(() => ({ kyc_status: 'pending', documents: [] })),
      Api.get('/onboarding/requirements').catch(() => ({ requirements: [], mandatory_pending: 0 })),
    ]);
    const rows = (d.documents || []).map(k => `<tr><td>${esc(k.doc_type)}</td><td>${esc(k.doc_number||'')}</td>
      <td>${UI.statusTag(k.status)}</td><td class="muted">${esc(k.remarks||'')}</td></tr>`).join('');
    const reqRows = (reqs.requirements || []).map(r => `<tr>
      <td>${r.verified ? '✅' : r.submitted ? '🕒' : '⬜'}</td><td>${esc(r.label)}</td>
      <td>${r.mandatory ? '<span class="muted">required</span>' : '<span class="muted">optional</span>'}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="grid cards"><div class="card"><div class="k">My KYC status</div><div class="v" style="font-size:20px">${UI.statusTag(d.kyc_status)}</div></div>
        <div class="card"><div class="k">Required documents pending</div><div class="v">${reqs.mandatory_pending ?? 0}</div></div></div>
      <div class="panel mt"><h2>Required for your role (${esc(reqs.role||State.user.role)})</h2>
        <div class="tbl-wrap"><table><thead><tr><th></th><th>Document</th><th></th></tr></thead>
        <tbody>${reqRows || '<tr><td colspan=3 class=muted>—</td></tr>'}</tbody></table></div></div>
      <div class="panel mt" style="max-width:560px"><h2>⚡ Instant verification</h2>
        <p class="muted">Verify PAN and Aadhaar digitally — your KYC is approved automatically on a match.</p>
        <div class="sechead" style="margin-top:6px">PAN</div>
        <div class="row" style="gap:8px;align-items:end">
          <div class="field" style="margin:0"><label>PAN</label><input id="vp_pan" placeholder="ABCDE1234F" maxlength="10" style="text-transform:uppercase"></div>
          <div class="field" style="margin:0;flex:1"><label>Name as on PAN</label><input id="vp_name"></div>
          <button class="btn sm" onclick="Actions.verifyPanNow()">Verify PAN</button>
        </div>
        <div id="vp_out" class="muted" style="font-size:12px;margin-top:6px"></div>
        <div class="sechead" style="margin-top:14px">Aadhaar (OTP)</div>
        <div class="row" style="gap:8px;align-items:end">
          <div class="field" style="margin:0"><label>Aadhaar (12 digit)</label><input id="va_num" inputmode="numeric" maxlength="12"></div>
          <button class="btn sm ghost" onclick="Actions.aadhaarSendOtpNow()">Send OTP</button>
        </div>
        <div id="va_otpbox" class="row hidden" style="gap:8px;align-items:end;margin-top:8px">
          <div class="field" style="margin:0"><label>Enter OTP</label><input id="va_otp" inputmode="numeric" maxlength="8" placeholder="6-digit"></div>
          <button class="btn sm" onclick="Actions.aadhaarVerifyOtpNow()">Verify OTP</button>
        </div>
        <div id="va_out" class="muted" style="font-size:12px;margin-top:6px"></div>
      </div>
      <div class="panel mt" style="max-width:520px"><h2>Submit a document</h2>
        <div class="field"><label>Document type</label>
          <select id="k_type"><option value="aadhaar">Aadhaar</option><option value="pan">PAN</option>
          <option value="gst">GST</option><option value="shop_photo">Shop photo</option>
          <option value="bank_proof">Bank proof</option><option value="selfie">Selfie</option></select></div>
        <div class="field"><label>Document number</label><input id="k_num"></div>
        <div class="field"><label>File URL (optional)</label><input id="k_url" placeholder="https://…"></div>
        <button class="btn" onclick="Actions.submitKyc()">Submit document</button></div>
      <div class="panel mt"><h2>My documents</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Type</th><th>Number</th><th>Status</th><th>Remarks</th></tr></thead>
        <tbody>${rows || '<tr><td colspan=4 class=muted>No documents submitted yet</td></tr>'}</tbody></table></div></div>`;
  },

  async wallet() {
    const w = await Api.get('/wallet');
    const l = await Api.get('/wallet/ledger?limit=25');
    const wd = await Api.get('/wallet/withdrawals?limit=10').catch(() => ({ items: [] }));
    const wdRows = (wd.items || []).map(x => `<tr><td class="right">${money(x.amount_paise/100)}</td>
      <td>${esc(x.account_number)} · ${esc(x.ifsc)}</td><td>${UI.statusTag(x.status)}</td>
      <td class="muted">${esc(x.utr||'')}</td><td class="muted">${new Date(x.created_at).toLocaleDateString('en-IN')}</td></tr>`).join('');
    const sw = w.sub_wallets || { settlement: '0.00', commission: '0.00', settlement_paise: 0, commission_paise: 0 };
    const rows = l.items.map(r => `<tr><td>${r.direction === 'credit' ? '＋' : '－'} ${money(r.amount)}</td>
      <td>${esc(r.source)}</td><td class="muted">${esc(r.description || '')}</td>
      <td class="right">${money(r.balance_after)}</td><td class="muted">${new Date(r.created_at).toLocaleString('en-IN')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="grid cards">
        <div class="card"><div class="k">Main wallet</div><div class="v">${money(w.wallet.balance)}</div>
          ${w.wallet.held_paise ? `<div class="muted" style="font-size:12px;margin-top:4px">Available <b>${money(w.wallet.available)}</b> · 🔒 blocked ${money(w.wallet.held)}</div>` : ''}
          <div class="row" style="gap:6px;margin-top:6px"><a class="btn sm ghost" href="#/addmoney">Add money</a>
          <button class="btn sm" onclick="Actions.withdraw()">Withdraw to bank</button></div></div>
        ${w.wallet.held_paise ? `<div class="card"><div class="k">Blocked (lien)</div><div class="v" style="color:var(--warn)">${money(w.wallet.held)}</div>
          <div class="muted" style="font-size:12px">Held by admin — can't be spent</div></div>` : ''}
        <div class="card"><div class="k">AePS settlement</div><div class="v">${money(sw.settlement)}</div>
          ${sw.settlement_paise > 0 ? `<button class="btn sm" onclick="Actions.sweep('settlement',${sw.settlement_paise/100})">Sweep to main</button>` : ''}</div>
        <div class="card"><div class="k">Commission (net of TDS)</div><div class="v">${money(sw.commission)}</div>
          ${sw.commission_paise > 0 ? `<button class="btn sm" onclick="Actions.sweep('commission',${sw.commission_paise/100})">Sweep to main</button>` : ''}</div>
      </div>
      <div class="panel mt"><div class="row" style="justify-content:space-between"><h2>Main wallet ledger</h2>
        <div class="row" style="gap:8px">
          <button class="btn sm ghost" onclick="Actions.openDoc('/wallet/statement?format=html')">🧾 Passbook</button>
          <button class="btn sm ghost" onclick="Actions.dl('/wallet/statement?format=csv','passbook.csv')">⬇ CSV</button>
          <button class="btn sm" onclick="Actions.topup()">Top up (test gateway)</button></div></div>
        <div class="tbl-wrap"><table><thead><tr><th>Amount</th><th>Source</th><th>Description</th><th class="right">Balance</th><th>When</th></tr></thead>
        <tbody>${rows || '<tr><td colspan=5 class=muted>No transactions yet</td></tr>'}</tbody></table></div></div>
      <div class="panel mt"><h2>Bank withdrawals</h2>
        <div class="tbl-wrap"><table><thead><tr><th class="right">Amount</th><th>To account</th><th>Status</th><th>UTR</th><th>When</th></tr></thead>
        <tbody>${wdRows || '<tr><td colspan=5 class=muted>No withdrawals yet</td></tr>'}</tbody></table></div></div>`;
  },
  // Request a wallet-to-bank withdrawal (agent cash-out).
  withdraw() {
    UI.modal(`<h3>Withdraw to bank</h3>
      <p class="muted" style="font-size:13px">The amount leaves your wallet now and is paid to your bank once admin approves. If rejected, it's refunded.</p>
      <div class="field"><label>Amount (₹)</label><input id="wd_amt" type="number" min="1" step="0.01"></div>
      <div class="field"><label>Account holder name</label><input id="wd_name"></div>
      <div class="field"><label>Account number</label><input id="wd_acc"></div>
      <div class="field"><label>IFSC</label><input id="wd_ifsc" placeholder="HDFC0001234"></div>
      <div class="field"><label>Mode</label><select id="wd_mode"><option>IMPS</option><option>NEFT</option><option>RTGS</option></select></div>
      <div class="foot"><button class="btn" onclick="Actions.submitWithdraw()">Request withdrawal</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async submitWithdraw() {
    const body = { amount: +val('wd_amt'), account_name: val('wd_name'), account_number: val('wd_acc'),
      ifsc: val('wd_ifsc').toUpperCase(), mode: val('wd_mode') };
    if (!body.amount || body.amount <= 0) return UI.toast('Enter an amount', 'err');
    try { await Api.post('/wallet/withdraw', body); UI.closeModal(); UI.toast('Withdrawal requested'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },

  // Member: PAN / GSTIN submission + TDS statement.
  async tax() {
    const [p, tds] = await Promise.all([
      Api.get('/tax/profile').catch(() => ({ profile: null })),
      Api.get('/tax/tds').catch(() => ({ items: [], total_tds: '0.00' })),
    ]);
    const pr = p.profile || {};
    const rows = (tds.items || []).map(r => `<tr><td>${esc(r.service_code||'')}</td><td>${esc(r.section)}</td>
      <td class="right">${money((r.gross_paise||0)/100)}</td><td>${(r.rate_bps/100).toFixed(0)}%</td>
      <td class="right">${money((r.tds_paise||0)/100)}</td><td class="right">${money((r.net_paise||0)/100)}</td>
      <td class="muted">${new Date(r.created_at).toLocaleString('en-IN')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="grid cards">
        <div class="card"><div class="k">PAN status</div><div class="v" style="font-size:18px">${pr.pan_valid ? UI.statusTag('verified') : UI.statusTag('pending')}</div></div>
        <div class="card"><div class="k">Total TDS deducted</div><div class="v">${money((tds.total_tds_paise||0)/100)}</div></div>
      </div>
      <div class="panel mt" style="max-width:520px"><h2>My PAN &amp; GST</h2>
        <p class="muted">A valid PAN lowers your commission TDS from 20% to 5% (Section 194H).</p>
        <div class="field"><label>PAN</label><input id="tx_pan" value="${esc(pr.pan||'')}" placeholder="ABCDE1234F"></div>
        <div class="field"><label>Name on PAN</label><input id="tx_name" value="${esc(pr.pan_name||'')}"></div>
        <div class="field"><label>GSTIN (optional)</label><input id="tx_gst" value="${esc(pr.gstin||'')}"></div>
        <div class="field"><label>State code</label><input id="tx_state" value="${esc(pr.state_code||'')}" placeholder="27"></div>
        <button class="btn" onclick="Actions.saveTaxProfile()">Save</button></div>
      <div class="panel mt"><div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h2 style="margin:0">My TDS statement</h2>
        <div class="row" style="gap:6px">
          <select id="tx_fy" style="max-width:150px">${taxFyOptions()}</select>
          <button class="btn sm ghost" onclick="Actions.openDoc('/tax/tds/statement?format=html&fy='+val('tx_fy'))">🧾 Certificate</button>
          <button class="btn sm" onclick="Actions.dl('/tax/tds/statement?format=csv&fy='+val('tx_fy'),'tds_'+val('tx_fy')+'.csv')">⬇ CSV</button>
        </div></div>
        <div class="tbl-wrap"><table>
        <thead><tr><th>Service</th><th>Section</th><th class="right">Gross</th><th>Rate</th><th class="right">TDS</th><th class="right">Net</th><th>When</th></tr></thead>
        <tbody>${rows || '<tr><td colspan=7 class=muted>No TDS yet</td></tr>'}</tbody></table></div></div>`;
  },

  // Add money: deposit into a company bank account (cash/bank/UPI) and
  // submit the reference for admin approval; also list my requests.
  async addmoney() {
    const [banks, mine] = await Promise.all([
      Api.get('/topup/bank-accounts').catch(() => ({ items: [] })),
      Api.get('/topup?limit=20').catch(() => ({ items: [] })),
    ]);
    const bankCards = banks.items.map(b => `
      <div class="card" style="text-align:left">
        <div class="k">${esc(b.label)}</div>
        <div style="font-size:14px;line-height:1.7">
          <b>${esc(b.bank_name)}</b><br>
          A/c Name: ${esc(b.account_name)}<br>
          A/c No: <b>${esc(b.account_number)}</b><br>
          IFSC: ${esc(b.ifsc)}${b.branch ? ' · ' + esc(b.branch) : ''}${b.upi_id ? '<br>UPI: <b>' + esc(b.upi_id) + '</b>' : ''}
          ${b.instructions ? '<br><span class="muted">' + esc(b.instructions) + '</span>' : ''}
        </div>
      </div>`).join('') || '<div class="muted">No bank accounts published yet — contact admin.</div>';
    const bankOpts = banks.items.map(b => `<option value="${b.id}">${esc(b.label)} — ${esc(b.account_number)}</option>`).join('');
    const rows = mine.items.map(t => `<tr><td>${money(t.amount)}</td><td>${esc(t.method)}</td>
      <td class="muted">${esc(t.reference || '')}</td><td>${UI.statusTag(t.status)}</td>
      <td class="muted">${esc(t.remarks || '')}</td>
      <td class="muted">${new Date(t.created_at).toLocaleString('en-IN')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="panel"><h2>Deposit to a company bank account</h2>
        <p class="muted">Transfer money to any account below (cash deposit, bank transfer or UPI), then submit the reference (UTR) here. Your wallet is credited after admin verifies it.</p>
        <div class="grid cards">${bankCards}</div></div>
      <div class="panel mt" style="max-width:560px"><h2>Submit a top-up request</h2>
        <div class="field"><label>Amount (₹)</label><input id="tu_amt" type="number" step="0.01" min="1"></div>
        <div class="field"><label>Method</label><select id="tu_method">
          <option value="cash_deposit">Cash deposit</option><option value="bank_transfer">Bank transfer</option>
          <option value="upi">UPI</option><option value="other">Other</option></select></div>
        <div class="field"><label>Deposited to account</label><select id="tu_bank"><option value="">— select —</option>${bankOpts}</select></div>
        <div class="field"><label>Reference / UTR</label><input id="tu_ref" placeholder="UTR / txn id"></div>
        <div class="field"><label>Proof URL (optional)</label><input id="tu_proof" placeholder="https://…"></div>
        <button class="btn" onclick="Actions.submitTopup()">Submit request</button></div>
      <div class="panel mt"><h2>My top-up requests</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Amount</th><th>Method</th><th>Reference</th><th>Status</th><th>Remarks</th><th>When</th></tr></thead>
        <tbody>${rows || '<tr><td colspan=6 class=muted>No requests yet</td></tr>'}</tbody></table></div></div>`;
  },

  new() {
    const svc = SERVICES.map(s => `<option value="${s.key}">${s.label}</option>`).join('');
    $('view').innerHTML = `
      <div class="panel" style="max-width:560px">
        <h2>New transaction</h2>
        <div class="field"><label>Service</label><select id="svc" onchange="Actions.svcFields()">${svc}</select></div>
        <div id="svc-fields"></div>
        <button class="btn mt" onclick="Actions.submitTxn()">Submit</button>
        <div id="txn-result" class="mt"></div>
      </div>`;
    if (Actions._preset) { $('svc').value = Actions._preset; Actions._preset = null; }
    Actions.svcFields();
  },

  async txns() {
    const d = await Api.get('/transactions?limit=40');
    const rows = d.items.map(t => `<tr>
      <td>${esc(t.service)}</td><td>${t.direction}</td><td class="right">${money(t.amount)}</td>
      <td class="right">${money(t.net)}</td><td>${UI.statusTag(t.status)}</td>
      <td class="muted">${esc(t.reference)}</td><td class="muted">${new Date(t.created_at).toLocaleString('en-IN')}</td>
      <td><button class="btn sm ghost" onclick="Actions.receipt('${t.id}')">Receipt</button>
        <button class="btn sm ghost" onclick="Actions.raiseDispute('${esc(t.reference)}','${esc(t.service)}')">Raise dispute</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between;align-items:end">
        <h2 style="margin:0">All transactions</h2>
        <div class="row" style="gap:8px;align-items:end">
          <div class="field" style="margin:0"><label>From</label><input id="st_from" type="date"></div>
          <div class="field" style="margin:0"><label>To</label><input id="st_to" type="date"></div>
          <button class="btn sm ghost" onclick="Actions.openDoc('/transactions/statement?format=html&'+Actions._range('st'))">🧾 Print statement</button>
          <button class="btn sm" onclick="Actions.dl('/transactions/statement?format=csv&'+Actions._range('st'),'statement.csv')">⬇ CSV</button>
        </div></div>
      <div class="tbl-wrap mt"><table>
      <thead><tr><th>Service</th><th>Dir</th><th class="right">Amount</th><th class="right">Net</th><th>Status</th><th>Reference</th><th>When</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=8 class=muted>No transactions</td></tr>'}</tbody></table></div></div>`;
  },

  async network() {
    const [panel, members, earn] = await Promise.all([
      Api.get('/network/panel').catch(() => null),
      Api.get('/network/members'),
      Api.get('/network/earnings?limit=10'),
    ]);
    const mrows = members.items.map(m => `<tr><td>${esc(m.full_name)}</td><td>${esc(m.username||'')}</td>
      <td>${esc(m.role)}</td><td>${esc(m.phone)}</td><td>${UI.statusTag(m.status)}</td>
      <td><button class="btn sm" onclick="Actions.pushFloat('${m.id}','${esc(m.full_name)}')">Push float</button></td></tr>`).join('');
    const erows = earn.items.map(e => `<tr><td>${esc(e.service_code)}</td><td>${esc(e.level)}</td>
      <td class="right">${money(e.amount_paise/100)}</td><td class="muted">${new Date(e.created_at).toLocaleString('en-IN')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="grid cards">
        <div class="card"><div class="k">Total earnings</div><div class="v">${money(earn.total_paise/100)}</div></div>
        <div class="card"><div class="k">Downline members</div><div class="v">${members.items.length}</div></div>
      </div>
      <div class="panel mt"><div class="row" style="justify-content:space-between"><h2>My members</h2>
        <button class="btn sm" onclick="Actions.addMember(false)">+ Add member</button></div>
        <p class="muted">Push float (working balance) from your wallet to a direct downline member.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Phone</th><th>Status</th><th></th></tr></thead>
        <tbody>${mrows || '<tr><td colspan=6 class=muted>No members yet</td></tr>'}</tbody></table></div></div>
      <div class="panel mt"><h2>Recent commission</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Service</th><th>Level</th><th class="right">Amount</th><th>When</th></tr></thead>
        <tbody>${erows || '<tr><td colspan=4 class=muted>None yet</td></tr>'}</tbody></table></div></div>`;
  },

  // Retailer: saved DMT/payout beneficiaries.
  async beneficiaries() {
    const d = await Api.get('/beneficiaries');
    const rows = (d.items || []).map(b => `<tr>
      <td>${esc(b.name)}</td><td>${esc(b.account_number)}</td><td>${esc(b.ifsc)}</td><td>${esc(b.bank_name||'')}</td>
      <td><button class="btn sm ghost" onclick="Actions.delBeneficiary('${b.id}')">Delete</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>Saved beneficiaries</h2>
      <button class="btn sm" onclick="Actions.addBeneficiary()">+ Add beneficiary</button></div>
      <p class="muted">Save payees once, then pick them on the DMT / payout screen.</p>
      <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Account</th><th>IFSC</th><th>Bank</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=5 class=muted>No saved beneficiaries yet.</td></tr>'}</tbody></table></div></div>`;
  },

  // Retailer: bound biometric / AEPS devices.
  async devices() {
    const d = await Api.get('/onboarding/devices');
    const rows = (d.items || []).map(v => `<tr>
      <td>${esc(v.label||'Device')}</td><td class="muted">${esc(v.device_uuid)}</td>
      <td>${esc(v.imei||'')}</td><td>${v.is_active ? UI.statusTag('active') : '<span class="tag">inactive</span>'}</td>
      <td class="muted">${v.bound_at ? new Date(v.bound_at).toLocaleDateString('en-IN') : ''}</td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>My devices</h2>
      <button class="btn sm" onclick="Actions.bindDevice()">+ Bind device</button></div>
      <p class="muted">Register the biometric scanner / mobile you use for AEPS so transactions are tied to a known device.</p>
      <div class="tbl-wrap"><table><thead><tr><th>Label</th><th>Device ID</th><th>IMEI</th><th>Status</th><th>Bound</th></tr></thead>
      <tbody>${rows || '<tr><td colspan=5 class=muted>No devices bound yet.</td></tr>'}</tbody></table></div></div>`;
  },

  // Finance: member wallet-to-bank withdrawals to approve / pay.
  async withdrawals() {
    const d = await Api.get('/admin/withdrawals?status=pending');
    const rows = (d.items || []).map(x => `<tr>
      <td>${esc(x.full_name)}<div class="muted" style="font-size:11px">${esc(x.role)}</div></td>
      <td class="right">${money(x.amount_paise/100)}</td>
      <td>${esc(x.account_name)}<div class="muted" style="font-size:11px">${esc(x.account_number)} · ${esc(x.ifsc)} · ${esc(x.mode)}</div></td>
      <td class="muted">${new Date(x.created_at).toLocaleString('en-IN')}</td>
      <td><button class="btn sm" onclick="Actions.payWithdrawal('${x.id}')">Mark paid</button>
          <button class="btn sm ghost" onclick="Actions.rejectWithdrawal2('${x.id}')">Reject</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><h2>Pending withdrawals</h2>
      <p class="muted">Agents' wallet-to-bank cash-outs. "Mark paid" records the bank UTR; "Reject" refunds their wallet.</p>
      <div class="tbl-wrap"><table><thead><tr><th>Member</th><th class="right">Amount</th><th>To account</th><th>Requested</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=5 class=muted>No pending withdrawals.</td></tr>'}</tbody></table></div></div>`;
  },

  // Member: my raised disputes.
  async mydisputes() {
    const d = await Api.get('/disputes');
    const rows = (d.items || []).map(x => `<tr>
      <td class="mono">${esc(x.ticket_no||'')}</td><td class="muted">${esc(x.reference||'')}</td>
      <td>${esc((x.category||'').replace(/_/g,' '))}</td><td>${UI.statusTag(x.status)}</td>
      <td class="muted">${esc(x.resolution||'')}</td>
      <td><button class="btn sm ghost" onclick="Actions.viewDispute('${x.id}',false)">View / reply</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>My disputes</h2>
      <button class="btn sm" onclick="Actions.raiseDispute()">+ Raise dispute</button></div>
      <p class="muted">Raise a complaint on a transaction (by reference id). Our team tracks and resolves it.</p>
      <div class="tbl-wrap"><table><thead><tr><th>Ticket</th><th>Ref</th><th>Category</th><th>Status</th><th>Resolution</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=6 class=muted>No disputes raised.</td></tr>'}</tbody></table></div></div>`;
  },
  // Admin/staff: disputes desk, searchable by reference / ticket.
  async disputes() {
    const q = Actions._dispSearch || '';
    const st = Actions._dispStatus || '';
    const ov = Actions._dispOverdue ? '&overdue=true' : '';
    const [d, sum] = await Promise.all([
      Api.get(`/admin/disputes?limit=100${q?'&q='+encodeURIComponent(q):''}${st?'&status='+st:''}${ov}`),
      Api.get('/admin/disputes-summary').catch(() => null),
    ]);
    const rows = (d.items || []).map(x => `<tr${x.overdue?' style="background:#fff5f5"':''}>
      <td class="mono">${esc(x.ticket_no||'')}</td>
      <td class="muted">${esc(x.reference||'')}<div style="font-size:11px">${esc(x.txn_service||'')} ${x.txn_amount_paise?money(x.txn_amount_paise/100):''}</div></td>
      <td>${esc(x.raised_by_name||'')}<div class="muted" style="font-size:11px">${esc(x.raised_by_phone||'')}</div></td>
      <td>${esc((x.category||'').replace(/_/g,' '))}<div class="muted" style="font-size:11px;max-width:220px;white-space:normal">${esc(x.description||'')}</div></td>
      <td>${UI.statusTag(x.status)}</td>
      <td>${slaBadge(x)}</td>
      <td><button class="btn sm" onclick="Actions.viewDispute('${x.id}',true)">Open</button></td></tr>`).join('');
    const stat = (label, val, cls) => `<div class="card"><div class="k">${label}</div><div class="v" style="font-size:20px;${cls||''}">${val}</div></div>`;
    const summary = sum ? `<div class="grid cards" style="margin-bottom:14px">
      ${stat('Open', sum.open)}
      ${stat('In review', sum.in_review)}
      ${stat('⏰ Overdue', sum.overdue, sum.overdue>0?'color:#c5221f':'')}
      ${stat('Due &lt; 2h', sum.due_soon, sum.due_soon>0?'color:#b26a00':'')}
      ${stat('Oldest open', sum.oldest_open_hours!=null?sum.oldest_open_hours+'h':'—')}
      ${stat('Avg resolve', sum.avg_resolution_hours!=null?sum.avg_resolution_hours+'h':'—')}
    </div>` : '';
    $('view').innerHTML = `<div class="panel"><h2>Disputes / complaints desk</h2>
      ${summary}
      <div class="row" style="gap:8px;margin-bottom:12px">
        <input id="disp_q" placeholder="Search by reference or ticket…" value="${esc(q)}" style="max-width:280px" onkeydown="if(event.key==='Enter')Actions.disputeSearch()">
        <select id="disp_status" onchange="Actions._dispStatus=this.value;Actions.disputeSearch()">
          <option value="">All statuses</option>
          ${['open','in_review','resolved','rejected'].map(s=>`<option value="${s}" ${st===s?'selected':''}>${s}</option>`).join('')}</select>
        <label class="row" style="gap:6px;align-items:center;font-size:13px"><input type="checkbox" ${Actions._dispOverdue?'checked':''} onchange="Actions._dispOverdue=this.checked;Actions.disputeSearch()"> Overdue only</label>
        <button class="btn sm" onclick="Actions.disputeSearch()">Search</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Ticket</th><th>Txn / ref</th><th>Raised by</th><th>Complaint</th><th>Status</th><th>SLA</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=7 class=muted>No disputes found.</td></tr>'}</tbody></table></div></div>`;
  },

  // Incoming provider callbacks / webhooks log.
  async webhooks() {
    const d = await Api.get('/admin/provider-events?limit=100');
    const rows = (d.items || []).map(e => `<tr>
      <td class="muted" style="white-space:nowrap">${new Date(e.received_at).toLocaleString('en-IN')}</td>
      <td>${esc(e.provider)}</td><td>${esc(e.event_type||'')}</td>
      <td class="muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(e.external_id||'')}</td>
      <td>${e.processed ? '<span class="tag active">processed</span>' : '<span class="tag">received</span>'}</td></tr>`).join('');
    const origin = location.origin;
    $('view').innerHTML = `<div class="panel"><h2>Webhook / callback log</h2>
      <p class="muted">Every signed callback from your providers. Each is verified (HMAC-SHA256), de-duplicated and settled — one callback works for <b>every service</b> because it settles by our reference id.</p>
      <div class="box" style="background:#f7f8fb;border:1px solid #e5e9f2;border-radius:10px;padding:14px 16px;margin:10px 0">
        <b>Callback URLs</b>
        <table style="margin-top:8px;font-size:13px"><tbody>
          <tr><td style="white-space:nowrap"><b>Per provider</b> (recommended)</td><td><code>${origin}/api/v1/webhooks/provider/&lt;providerId&gt;</code> — shown on each row under <a href="#/providers">Providers</a>; uses that provider's own secret.</td></tr>
          <tr><td style="white-space:nowrap"><b>Shared aggregator</b></td><td><code>${origin}/api/v1/webhooks/aggregator</code> — one URL for all providers, uses the global secret set under <a href="#/website">Website</a>.</td></tr>
          <tr><td style="white-space:nowrap"><b>Razorpay</b></td><td><code>${origin}/api/v1/webhooks/razorpay</code> — payment + payout events.</td></tr>
        </tbody></table>
        <div style="margin-top:10px"><b>Signature header:</b> <code>X-Webhook-Signature: HMAC_SHA256(rawBody, secret)</code> (hex; a <code>sha256=</code> prefix is accepted too).</div>
        <div style="margin-top:10px"><b>Body</b> — send any of these and we map it. Only <code>reference</code> + <code>status</code> are required:</div>
        <pre style="background:#fff;border:1px solid #e5e9f2;border-radius:8px;padding:10px;overflow:auto;font-size:12px">{
  "reference": "2LNYKFTLYRJ5CFF",     // our reference (aliases: client_ref, refid, order_id…)
  "status":    "success",              // success | pending | failed (many spellings accepted)
  "utr":       "AXISN1234567890",      // optional bank UTR / RRN (aliases: rrn, bank_ref)
  "provider_ref": "OP987654",          // optional provider txn id
  "message":   "Txn successful"        // optional
}</pre>
        <div class="muted" style="font-size:12px">success → settle &amp; pay commission · failed → auto-reverse the full wallet deduction · pending → hold, no wallet change until a final callback.</div>
      </div>
      <div class="tbl-wrap"><table><thead><tr><th>Received</th><th>Provider</th><th>Event</th><th>Ref / id</th><th>Status</th></tr></thead>
      <tbody>${rows || '<tr><td colspan=5 class=muted>No callbacks received yet.</td></tr>'}</tbody></table></div></div>`;
  },

  // Super admin: activity audit log (who did what).
  async audit() {
    const d = await Api.get('/admin/audit?limit=100');
    const label = { 'kyc.review':'KYC review', 'topup.approve':'Top-up approved', 'topup.reject':'Top-up rejected',
      'hold.place':'Lien placed', 'hold.release':'Lien released', 'user.status':'User status changed',
      'staff.create':'Staff created', 'staff.permissions':'Staff permissions changed', 'staff.status':'Staff status changed',
      'provider.activate':'Provider activated', 'provider.deactivate':'Provider deactivated',
      'adjustment.approve':'Adjustment approved', 'adjustment.reject':'Adjustment rejected',
      'txn.refund':'Transaction refunded', 'txn.resolve':'Pending resolved',
      'dispute.resolved':'Dispute resolved', 'dispute.rejected':'Dispute rejected', 'dispute.in_review':'Dispute in review' };
    const rows = (d.items || []).map(a => {
      const det = a.detail || {};
      const note = det.remarks || det.reason || det.note || '';
      const extra = det.amount_paise ? ' · ' + money(det.amount_paise/100) : (det.status ? ' · ' + esc(det.status) : '');
      return `<tr>
        <td class="muted" style="white-space:nowrap">${new Date(a.created_at).toLocaleString('en-IN')}</td>
        <td>${esc(a.actor_name || '—')}<div class="muted" style="font-size:11px">${esc(a.actor_role||'')}</div></td>
        <td>${esc(label[a.action] || a.action)}${extra}</td>
        <td class="muted">${esc(a.target_type||'')} ${a.target_id ? esc(String(a.target_id).slice(0,8)) : ''}</td>
        <td>${note ? esc(note) : '<span class="muted">—</span>'}</td></tr>`;
    }).join('');
    $('view').innerHTML = `<div class="panel"><h2>Activity audit log</h2>
      <p class="muted">Append-only trail of sensitive back-office actions — approvals, liens, staff &amp; provider changes — with the remark.</p>
      <div class="tbl-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Remark</th></tr></thead>
      <tbody>${rows || '<tr><td colspan=5 class=muted>No activity recorded yet.</td></tr>'}</tbody></table></div></div>`;
  },

  // Super admin: staff team + scoped permissions.
  async staff() {
    const [cat, list] = await Promise.all([Api.get('/staff/catalog'), Api.get('/staff')]);
    App._permCatalog = cat;
    const rows = (list.items || []).map(s => `<tr>
      <td>${esc(s.full_name)}</td><td class="muted">${esc(s.email)}</td>
      <td>${s.kind === 'ai' ? '🤖 AI agent' + (s.active_tokens ? ' <span class="tag active">key</span>' : ' <span class="tag">no key</span>') : '👤 Human'}</td>
      <td>${UI.statusTag(s.status)}</td>
      <td>${(s.permissions||[]).length} power(s)</td>
      <td>
        <button class="btn sm" onclick='Actions.editStaff(${JSON.stringify(s).replace(/'/g,"&#39;")})'>Permissions</button>
        ${s.kind === 'ai' ? `<button class="btn sm ghost" onclick="Actions.regenToken('${s.id}')">New key</button>
          ${s.active_tokens ? `<button class="btn sm ghost" onclick="Actions.revokeToken('${s.id}')">Revoke key</button>` : ''}` : ''}
        ${s.status === 'active'
          ? `<button class="btn sm ghost" onclick="Actions.staffStatus('${s.id}','suspended')">Suspend</button>`
          : `<button class="btn sm" onclick="Actions.staffStatus('${s.id}','active')">Activate</button>`}
      </td></tr>`).join('');
    $('view').innerHTML = `
      <div class="panel"><div class="row" style="justify-content:space-between"><h2>Staff &amp; roles</h2>
        <div class="row" style="gap:8px"><button class="btn sm" onclick="Actions.addStaff('human')">+ Human staff</button>
        <button class="btn sm ghost" onclick="Actions.addStaff('ai')">+ AI agent</button></div></div>
        <p class="muted">Human staff sign in to this console; AI agents authenticate with an API key (for n8n / automation) — both obey the same permissions.</p>
        <div class="tbl-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Status</th><th>Powers</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan=6 class=muted>No staff yet — add your first team member or AI agent.</td></tr>'}</tbody></table></div></div>`;
  },

  async members() {
    const d = await Api.get('/admin/users?limit=50');
    const rows = d.items.map(u => `<tr>
      <td>${esc(u.full_name)}</td><td>${esc(u.username||'')}</td><td>${esc(u.role)}</td>
      <td>${esc(u.phone)}</td><td>${UI.statusTag(u.status)}</td><td>${UI.statusTag(u.kyc_status)}</td>
      <td>
        ${u.status === 'active'
          ? `<button class="btn sm ghost" onclick="Actions.setStatus('${u.id}','suspended')">Suspend</button>`
          : `<button class="btn sm" onclick="Actions.setStatus('${u.id}','active')">Activate</button>`}
        <button class="btn sm ghost" onclick="Actions.resetUserPw('${u.id}','${esc(u.full_name)}')">Reset PW</button>
        ${u.role !== 'admin' ? `<button class="btn sm ghost" onclick="Actions.holds('${u.id}','${esc(u.full_name)}')">Lien</button>
        <button class="btn sm ghost" onclick="Actions.assessOnb('${u.id}')">Score</button>
        <button class="btn sm ghost" onclick="Actions.setUserPlan('${u.id}','${esc(u.full_name)}','${u.commission_plan_id||''}')">Plan</button>
        <button class="btn sm ghost" onclick="Actions.promote('${u.id}')">Promote</button>` : ''}
      </td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between">
      <h2>Users</h2><button class="btn sm" onclick="Actions.addMember(true)">+ Create member</button></div>
      <p class="muted">Score = onboarding risk assessment; Promote moves a member from probation to full daily-limit tier.</p>
      <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Phone</th><th>Status</th><th>KYC</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  },

  async kycreview() {
    const d = await Api.get('/kyc/pending');
    const rows = d.items.map(k => `<tr><td>${esc(k.full_name)}</td><td>${esc(k.role)}</td>
      <td>${esc(k.doc_type)}</td><td>${esc(k.doc_number || '')}</td>
      <td><button class="btn sm" onclick="Actions.reviewKyc('${k.id}','verified')">Approve</button>
          <button class="btn sm ghost" onclick="Actions.reviewKyc('${k.id}','rejected')">Reject</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><h2>Pending KYC</h2><div class="tbl-wrap"><table>
      <thead><tr><th>User</th><th>Role</th><th>Document</th><th>Number</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=5 class=muted>Nothing pending</td></tr>'}</tbody></table></div></div>`;
  },

  async plans() {
    const d = await Api.get('/admin/commission-plans');
    const list = d.items || [];
    if (!list.length) {
      $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>Commission plans</h2>
        <button class="btn sm" onclick="Actions.createPlan()">+ New plan</button></div>
        <p class="muted">No commission plan yet. Create one to define per-service, per-tier commission.</p></div>`;
      return;
    }
    const sel = Actions._planId && list.some(p => p.id === Actions._planId) ? Actions._planId
      : (list.find(p => p.is_default) || list[0]).id;
    const plan = list.find(p => p.id === sel);
    const opts = list.map(p => `<option value="${p.id}" ${p.id===sel?'selected':''}>${esc(p.name)}${p.is_default?' (default)':''}</option>`).join('');
    const full = await Api.get('/admin/commission-plans/' + sel);
    const rows = full.rules.map(r => `<tr><td>${esc(r.service_code.replace(/_/g,' '))}</td>
      <td>${money(r.min_amount_paise/100)}–${r.max_amount_paise > 1e15 ? '∞' : money(r.max_amount_paise/100)}</td>
      <td>${esc(r.charge_type)} ${r.charge_value}</td>
      <td class="comm-pos">R:${r.retailer_value} D:${r.distributor_value} MD:${r.master_distributor_value} A:${r.admin_value}</td>
      <td><button class="btn sm ghost" onclick="Actions.deleteRule('${sel}','${r.id}')">✕</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel">
      <div class="row" style="justify-content:space-between;align-items:end">
        <div class="field" style="margin:0;max-width:320px"><label>Commission plan</label>
          <select id="pl_sel" onchange="Actions._planId=this.value;App.route()">${opts}</select></div>
        <div class="row" style="gap:8px">
          <button class="btn sm ghost" onclick="Actions.createPlan()">+ New plan</button>
          ${plan.is_default ? '<span class="tag active" style="align-self:center">default</span>' : `<button class="btn sm ghost" onclick="Actions.setDefaultPlan('${sel}')">Make default</button>`}
          ${plan.is_default ? '' : `<button class="btn sm ghost" onclick="Actions.deletePlan('${sel}')">Delete plan</button>`}
        </div></div>
      <p class="muted" style="margin:10px 0 0">Rules define the per-service commission split (retailer / distributor / master-distributor / admin) and any charge. Assign this plan to a member from <a href="#/members">Users</a> → <b>Plan</b>. Members with no plan use the default.</p>
      <div class="row" style="justify-content:space-between;margin-top:12px"><h2 style="margin:0">Rules — ${esc(plan.name)}</h2>
        <button class="btn sm" onclick="Actions.addRule('${sel}')">+ Add rule</button></div>
      <div class="tbl-wrap mt"><table><thead><tr><th>Service</th><th>Slab</th><th>Charge</th><th>Commission (R/D/MD/A)</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=5 class=muted>No rules — add one so commissions apply</td></tr>'}</tbody></table></div></div>`;
  },

  async adminservices() {
    const d = await Api.get('/admin/services');
    const inf = 9223372036854775807;
    const rows = d.items.map(s => `<tr><td>${esc(s.code)}</td><td>${esc(s.name)}</td>
      <td>${s.enabled ? '<span class="tag active">on</span>' : '<span class="tag blocked">off</span>'}</td>
      <td>${money((s.activation_charge_paise||0)/100)}</td>
      <td>${money((s.min_commission_paise||0)/100)} – ${(+s.max_commission_paise>=inf) ? '∞' : money((s.max_commission_paise||0)/100)}</td>
      <td>
        <button class="btn sm ghost" onclick="Actions.toggleService('${s.code}',${!s.enabled})">${s.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn sm ghost" onclick="Actions.setServiceLimits('${s.code}',${s.min_commission_paise||0},'${(+s.max_commission_paise>=inf)?'':((s.max_commission_paise||0)/100)}')">Limits</button>
        <button class="btn sm" onclick="location.hash='#/providers';Actions._provService='${s.code}'">Providers</button>
      </td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><h2>Services</h2>
      <p class="muted">Set the per-service commission floor/ceiling; commission rules must stay within these bounds. Manage upstream providers per service.</p>
      <div class="tbl-wrap"><table>
      <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Activation</th><th>Commission min–max</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  },

  // Admin: review wallet top-up requests.
  async topupreview() {
    const d = await Api.get('/admin/topups?status=pending&limit=50');
    const rows = d.items.map(t => `<tr>
      <td>${esc(t.full_name)} <span class="muted">${esc(t.username||'')}</span></td>
      <td>${esc(t.role)}</td><td class="right">${money(t.amount)}</td><td>${esc(t.method)}</td>
      <td class="muted">${esc(t.reference||'')}</td>
      <td>${t.proof_url ? `<a href="${esc(t.proof_url)}" target="_blank">proof</a>` : ''}</td>
      <td>${new Date(t.created_at).toLocaleString('en-IN')}</td>
      <td><button class="btn sm" onclick="Actions.approveTopup('${t.id}')">Approve</button>
          <button class="btn sm ghost" onclick="Actions.rejectTopup('${t.id}')">Reject</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><h2>Pending top-up requests</h2><div class="tbl-wrap"><table>
      <thead><tr><th>Member</th><th>Role</th><th class="right">Amount</th><th>Method</th><th>Reference</th><th>Proof</th><th>When</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=8 class=muted>Nothing pending</td></tr>'}</tbody></table></div></div>`;
  },

  // Admin: manage company bank accounts shown to the network for deposits.
  async bankaccounts() {
    const d = await Api.get('/admin/bank-accounts');
    const rows = d.items.map(b => `<tr>
      <td>${esc(b.label)}</td><td>${esc(b.bank_name)}</td><td>${esc(b.account_name)}</td>
      <td>${esc(b.account_number)}</td><td>${esc(b.ifsc)}</td><td>${esc(b.upi_id||'')}</td>
      <td>${b.is_active ? '<span class="tag active">active</span>' : '<span class="tag blocked">off</span>'}</td>
      <td><button class="btn sm ghost" onclick="Actions.toggleBank('${b.id}',${!b.is_active})">${b.is_active ? 'Disable' : 'Enable'}</button>
          <button class="btn sm ghost" onclick="Actions.deleteBank('${b.id}')">Delete</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between">
      <h2>Company bank accounts</h2><button class="btn sm" onclick="Actions.addBank()">+ Add account</button></div>
      <p class="muted">These accounts are shown to master distributors, distributors and retailers for cash / bank / UPI deposits.</p>
      <div class="tbl-wrap"><table>
      <thead><tr><th>Label</th><th>Bank</th><th>A/c name</th><th>A/c no</th><th>IFSC</th><th>UPI</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=8 class=muted>No accounts yet</td></tr>'}</tbody></table></div></div>`;
  },

  // Admin: double-entry journal audit view.
  async ledger() {
    const [d, acc] = await Promise.all([
      Api.get('/admin/ledger/journal?limit=40'),
      Api.get('/admin/ledger/accounts').catch(() => ({ items: [] })),
    ]);
    const accRows = (acc.items || []).map(a => `<tr><td>${esc(a.code)}</td><td>${esc(a.name||'')}</td>
      <td class="muted">${esc(a.type||'')}</td><td class="muted">${esc(a.normal_balance||'')}${a.per_member?' · per-member':''}</td></tr>`).join('');
    const accBlock = accRows ? `<div class="panel mt"><h2>Chart of accounts</h2><div class="tbl-wrap"><table>
      <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Normal side</th></tr></thead>
      <tbody>${accRows}</tbody></table></div></div>` : '';
    const blocks = d.items.map(e => {
      const lines = e.lines.map(l => `<tr>
        <td>${l.direction === 'debit' ? 'DR' : '&nbsp;&nbsp;CR'}</td>
        <td>${esc(l.account_code)}${l.wallet_owner ? ' <span class="muted">('+esc(l.wallet_owner)+')</span>' : ''}</td>
        <td class="right">${l.direction === 'debit' ? money(l.amount) : ''}</td>
        <td class="right">${l.direction === 'credit' ? money(l.amount) : ''}</td></tr>`).join('');
      return `<div class="panel mt"><div class="row" style="justify-content:space-between">
        <b>${esc(e.source)}</b><span class="muted">${new Date(e.created_at).toLocaleString('en-IN')}${e.reference ? ' · '+esc(e.reference) : ''}</span></div>
        <div class="muted" style="margin:2px 0 8px">${esc(e.narration||'')}</div>
        <div class="tbl-wrap"><table><thead><tr><th></th><th>Account</th><th class="right">Debit</th><th class="right">Credit</th></tr></thead>
        <tbody>${lines}</tbody></table></div></div>`;
    }).join('');
    $('view').innerHTML = `<div class="panel"><h2>Double-entry ledger</h2>
      <p class="muted">Immutable journal — every entry has equal debits and credits.</p></div>${accBlock}${blocks || '<div class="panel muted">No journal entries yet</div>'}`;
  },

  // Admin: TDS (194H/194N) + GST desk.
  async taxdesk() {
    const [tds, gst, cfg] = await Promise.all([Api.get('/admin/tds'), Api.get('/admin/gst'), Api.get('/admin/tax-config')]);
    const crows = cfg.items.map(c => `<tr>
      <td>${esc(c.label)}</td>
      <td><input id="tc_rate_${c.code}" type="number" step="0.01" min="0" value="${(c.rate_bps/100)}" style="width:90px"> %</td>
      <td>₹<input id="tc_max_${c.code}" type="number" step="0.01" min="0" value="${(c.max_amount_paise/100)}" style="width:110px"></td>
      <td><input id="tc_en_${c.code}" type="checkbox" ${c.enabled?'checked':''}></td></tr>`).join('');
    const cfgCodes = JSON.stringify(cfg.items.map(c => c.code));
    const trows = tds.items.map(r => `<tr><td>${esc(r.full_name)}</td><td>${esc(r.service_code||'')}</td>
      <td>${esc(r.section)}</td><td class="right">${money((r.gross_paise||0)/100)}</td>
      <td>${(r.rate_bps/100).toFixed(0)}%</td><td class="right">${money((r.tds_paise||0)/100)}</td>
      <td class="muted">${new Date(r.created_at).toLocaleString('en-IN')}</td></tr>`).join('');
    const grows = gst.items.map(r => `<tr><td>${esc(r.service_code||'')}</td>
      <td class="right">${money((r.taxable_base_paise||0)/100)}</td>
      <td class="right">${money((r.cgst_paise||0)/100)}</td><td class="right">${money((r.sgst_paise||0)/100)}</td>
      <td class="right">${money((r.igst_paise||0)/100)}</td><td>${esc(r.place_of_supply||'')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="grid cards">
        <div class="card"><div class="k">TDS withheld (Form 26Q)</div><div class="v">${money((tds.total_tds_paise||0)/100)}</div></div>
        <div class="card"><div class="k">GST collected</div><div class="v">${money((gst.total_gst_paise||0)/100)}</div></div>
        <div class="card"><div class="k">Taxable base</div><div class="v">${money((gst.total_base_paise||0)/100)}</div></div>
      </div>
      <div class="panel mt"><h2>Tax rates &amp; caps</h2>
        <p class="muted">Set the rate and an optional maximum tax amount per transaction (0 = no cap). Applied live to new transactions.</p>
        <div class="tbl-wrap"><table>
        <thead><tr><th>Tax</th><th>Rate</th><th>Max per txn</th><th>On</th></tr></thead>
        <tbody data-codes='${cfgCodes}'>${crows}</tbody></table></div>
        <button class="btn sm mt" onclick='Actions.saveTaxConfig(${cfgCodes})'>Save tax rates</button></div>
      <div class="panel mt"><div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <h2 style="margin:0">TDS records (Section 194H / 194N)</h2>
          ${_rangeCtl('tx')}
          <button class="btn sm" onclick="Actions.dl('/admin/tds?format=csv&'+Actions._range('tx'),'tds_26q.csv')">⬇ 26Q CSV</button></div>
        <div class="tbl-wrap"><table>
        <thead><tr><th>Member</th><th>Service</th><th>Section</th><th class="right">Gross</th><th>Rate</th><th class="right">TDS</th><th>When</th></tr></thead>
        <tbody>${trows || '<tr><td colspan=7 class=muted>No TDS yet</td></tr>'}</tbody></table></div></div>
      <div class="panel mt"><div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <h2 style="margin:0">GST invoices (18% on platform margin)</h2>
          <button class="btn sm" onclick="Actions.dl('/admin/gst?format=csv&'+Actions._range('tx'),'gst.csv')">⬇ GST CSV</button></div>
        <div class="tbl-wrap"><table>
        <thead><tr><th>Service</th><th class="right">Base</th><th class="right">CGST</th><th class="right">SGST</th><th class="right">IGST</th><th>PoS</th></tr></thead>
        <tbody>${grows || '<tr><td colspan=6 class=muted>No GST yet</td></tr>'}</tbody></table></div>
        <p class="muted" style="font-size:12px;margin-top:8px">Both exports honour the date range above. Leave dates blank for all-time.</p></div>`;
  },

  // Admin: reconciliation batches (upload MIS -> match + auto force-settle).
  async recon() {
    const d = await Api.get('/admin/recon/batches');
    const rows = d.items.map(b => `<tr><td>${esc(b.label)}</td><td>${b.total_records}</td>
      <td class="right">${b.matched}</td><td class="right">${b.force_settled}</td>
      <td class="right">${b.exceptions}</td><td class="muted">${new Date(b.created_at).toLocaleString('en-IN')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="panel"><h2>Run reconciliation</h2>
        <p class="muted">Paste the bank/switch settlement feed (MIS) as JSON rows: <code>[{"reference":"DMT...","bank_status":"settled","amount_paise":100000,"rrn":"..."}]</code>. Matches the internal ledger, force-settles timed-out (pending) transactions and flags false-successes.</p>
        <div class="field"><label>Label</label><input id="rc_label" value="EOD ${new Date().toISOString().slice(0,10)}"></div>
        <div class="field"><label>MIS rows (JSON)</label><textarea id="rc_rows" rows="6" style="width:100%;font-family:monospace">[{"reference":"","bank_status":"settled"}]</textarea></div>
        <button class="btn" onclick="Actions.runRecon()">Run reconciliation</button></div>
      <div class="panel mt"><h2>Stale pending sweep (auto-recon)</h2>
        <p class="muted">Find transactions stuck in <b>pending</b> — the provider never sent a final status — and fail them, which reverses the debit and refunds the member. Idempotent: a late callback on a swept txn is a no-op. The background sweeper runs this automatically when <b>Auto-recon</b> is set under Website settings.</p>
        <div class="row" style="gap:8px;align-items:end">
          <div class="field" style="margin:0"><label>Older than (minutes)</label><input id="sweep_min" type="number" value="120" min="60" style="max-width:140px"></div>
          <button class="btn sm ghost" onclick="Actions.listStale()">Preview</button>
          <button class="btn sm" onclick="Actions.sweepStale()">Sweep &amp; refund</button></div>
        <div id="stale_out" class="muted mt">Preview to see how many pendings are stale.</div></div>
      <div class="panel mt"><h2>Recent batches</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Label</th><th>Records</th><th class="right">Matched</th><th class="right">Force-settled</th><th class="right">Exceptions</th><th>When</th></tr></thead>
        <tbody>${rows || '<tr><td colspan=6 class=muted>No batches yet</td></tr>'}</tbody></table></div></div>`;
  },

  // Admin: batch payout engine.
  async batchpayout() {
    const d = await Api.get('/admin/payout-batches');
    const rows = d.items.map(b => `<tr><td>${esc(b.label)}</td><td>${esc(b.rail)}</td>
      <td class="right">${money((b.total_paise||0)/100)}</td><td class="right">${b.record_count}</td>
      <td class="right">${b.settled_count}</td><td class="right">${b.returned_count}</td>
      <td>${UI.statusTag(b.status)}</td>
      <td><a class="btn sm ghost" href="${Cfg.API}/admin/payout-batches/${b.id}/file" target="_blank">File</a>
          <button class="btn sm" onclick="Actions.reverseFeed('${b.id}')">Reverse feed</button></td></tr>`).join('');
    $('view').innerHTML = `
      <div class="panel"><h2>Create payout batch</h2>
        <p class="muted">Records JSON: <code>[{"user_id":"...","amount":3000,"beneficiary_name":"...","account_number":"...","ifsc":"..."}]</code>. Debits each member's settlement wallet into the payout-clearing hold; rail auto-routes (&lt;₹2L NEFT, ≥₹2L RTGS).</p>
        <div class="field"><label>Label</label><input id="bp_label" value="EOD ${new Date().toISOString().slice(0,10)}"></div>
        <div class="field"><label>Records (JSON)</label><textarea id="bp_rows" rows="5" style="width:100%;font-family:monospace">[]</textarea></div>
        <button class="btn" onclick="Actions.createBatch()">Create batch (hold funds)</button></div>
      <div class="panel mt"><h2>Batches</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Label</th><th>Rail</th><th class="right">Total</th><th class="right">Records</th><th class="right">Settled</th><th class="right">Returned</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan=8 class=muted>No batches</td></tr>'}</tbody></table></div></div>`;
  },

  // Admin: treasury liquidity (escrow balances + sweeps).
  async treasury() {
    const d = await Api.get('/admin/treasury/balances');
    const rows = d.items.map(i => `<tr><td>${esc(i.account)}</td><td class="muted">${esc(i.name)}</td>
      <td class="right">${money((i.balance_paise||0)/100)}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="panel"><h2>Escrow / asset balances</h2>
        <p class="muted">Derived from the double-entry journal.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Account</th><th>Name</th><th class="right">Balance</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>
      <div class="panel mt" style="max-width:520px"><h2>Liquidity sweep</h2>
        <p class="muted">Two-phase asset-to-asset move via the in-transit clearing account.</p>
        <div class="field"><label>From</label><select id="tr_from"><option value="bank_escrow">bank_escrow (collection)</option><option value="payout_escrow">payout_escrow</option></select></div>
        <div class="field"><label>To</label><select id="tr_to"><option value="payout_escrow">payout_escrow</option><option value="bank_escrow">bank_escrow (collection)</option></select></div>
        <div class="field"><label>Amount (₹)</label><input id="tr_amt" type="number" step="0.01" min="1"></div>
        <button class="btn" onclick="Actions.treasurySweep()">Execute sweep</button></div>`;
  },

  // Admin: ops desk — maker-checker manual adjustments.
  async opsdesk() {
    const [d, tx] = await Promise.all([
      Api.get('/admin/adjustments'),
      Api.get('/admin/transactions?limit=60').catch(() => ({ items: [] })),
    ]);
    const txRows = (tx.items || []).map(t => `<tr>
      <td class="muted">${new Date(t.created_at).toLocaleString('en-IN')}</td>
      <td>${esc(t.user_name||'')}</td><td>${esc(t.service)}</td>
      <td class="right">${money((t.amount_paise||0)/100)}</td>
      <td>${UI.statusTag(t.status)}</td>
      <td>${t.status === 'pending'
        ? `<button class="btn sm" onclick="Actions.resolveTxn('${t.id}','success')">Mark success</button>
           <button class="btn sm ghost" onclick="Actions.resolveTxn('${t.id}','failed')">Mark failed</button>`
        : (t.status === 'success' && t.direction === 'debit'
          ? `<button class="btn sm ghost" onclick="Actions.refundTxn('${t.id}')">Refund</button>` : '')}</td></tr>`).join('');
    const txPanel = `<div class="panel mt"><h2>Transaction ops — resolve pending &amp; refund</h2>
      <p class="muted">Force a stuck pending transaction to success/failed (failure auto-reverses the wallet), or refund a completed debit transaction (refunds the payer &amp; claws back commission).</p>
      <div class="tbl-wrap"><table><thead><tr><th>When</th><th>Member</th><th>Service</th><th class="right">Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${txRows || '<tr><td colspan=6 class=muted>No transactions</td></tr>'}</tbody></table></div></div>`;
    const rows = d.items.map(a => `<tr>
      <td>${esc(a.target_name)}</td><td>${esc(a.kind)}</td><td class="right">${money((a.amount_paise||0)/100)}</td>
      <td class="muted">${esc(a.reason)}</td><td>${esc(a.maker_name||'')}</td>
      <td>${UI.statusTag(a.status)}</td>
      <td>${a.status === 'proposed'
        ? `<button class="btn sm" onclick="Actions.decideAdj('${a.id}','approve')">Approve</button>
           <button class="btn sm ghost" onclick="Actions.decideAdj('${a.id}','reject')">Reject</button>`
        : esc(a.checker_name||'')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="panel"><div class="row" style="justify-content:space-between"><h2>Ops desk — manual adjustments</h2>
        <button class="btn sm" onclick="Actions.proposeAdj()">+ Propose adjustment</button></div>
        <p class="muted">Dual control: one officer proposes, a different officer approves before any money moves.</p>
        <div class="tbl-wrap"><table>
        <thead><tr><th>Member</th><th>Kind</th><th class="right">Amount</th><th>Reason</th><th>Maker</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan=7 class=muted>No adjustments</td></tr>'}</tbody></table></div></div>
      ${txPanel}`;
  },
  async resolveTxn(id, decision) {
    const remark = prompt(`Mark this transaction ${decision} — enter a remark (required):`, '');
    if (remark === null) return;
    if (!remark.trim()) return UI.toast('A remark is required', 'err');
    try { await Api.post(`/admin/transactions/${id}/resolve`, { decision, remark: remark.trim() }); UI.toast(`Marked ${decision}`); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // ----- disputes -----
  raiseDispute(reference, service) {
    UI.modal(`<h3>Raise a dispute</h3>
      <div class="field"><label>Transaction reference</label><input id="dp_ref" value="${esc(reference||'')}" placeholder="15-char reference id" ${reference?'readonly':''}></div>
      <div class="field"><label>Category</label><select id="dp_cat">
        <option value="not_credited">Amount debited, service not delivered</option>
        <option value="wrong_amount">Wrong amount</option>
        <option value="double_charge">Charged twice</option>
        <option value="service_failed">Service failed</option>
        <option value="other">Other</option></select></div>
      <div class="field"><label>Customer ref (optional)</label><input id="dp_cust" placeholder="customer phone / name"></div>
      <div class="field"><label>Describe the problem</label><textarea id="dp_desc" rows="3" style="width:100%" placeholder="What went wrong?"></textarea></div>
      <div class="foot"><button class="btn" onclick="Actions.submitDispute()">Submit to support</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async submitDispute() {
    const body = { reference: val('dp_ref'), category: val('dp_cat'), description: $('dp_desc').value.trim() };
    if (val('dp_cust')) body.customer_ref = val('dp_cust');
    if (!body.reference) return UI.toast('Enter the transaction reference', 'err');
    if (body.description.length < 5) return UI.toast('Please describe the problem', 'err');
    try { const d = await Api.post('/disputes', body); UI.closeModal(); UI.toast('Dispute raised — ticket ' + (d.dispute.ticket_no||'')); location.hash = '#/mydisputes'; App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  disputeSearch() { Actions._dispSearch = ($('disp_q')||{}).value || ''; App.route(); },
  // Full dispute detail: thread + reply (+ resolve/refund/print for staff).
  async viewDispute(id, isAdmin) {
    Actions._dispCtx = { id, isAdmin };
    const base = isAdmin ? '/admin/disputes/' + id : '/disputes/' + id;
    const d = await Api.get(base);
    const dp = d.dispute; const msgs = d.messages || [];
    const thread = msgs.map(m => {
      const mine = m.author_role === 'retailer';
      const tag = m.type !== 'comment' ? ` · <b>${esc(m.type.replace('_',' '))}${m.status_to?' → '+esc(m.status_to):''}</b>` : '';
      return `<div style="margin:8px 0;padding:8px 11px;border-radius:9px;background:${mine?'var(--accent-soft,#eef1ff)':'#eef7ef'}">
        <div class="muted" style="font-size:11px">${esc(m.author_role)} · ${new Date(m.created_at).toLocaleString('en-IN')}${tag}</div>
        <div>${esc(m.message)}</div></div>`;
    }).join('');
    const open = ['open','in_review'].includes(dp.status);
    const staffPanel = isAdmin ? `
      <div class="field mt"><label>Resolution / status note</label><textarea id="dp_res" rows="2" style="width:100%"></textarea></div>
      <label style="display:flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" id="dp_refund"> Resolve as refund (credit the payer's wallet)</label>
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="btn sm" onclick="Actions.resolveDisputeFull('resolved')">Resolve</button>
        <button class="btn sm ghost" onclick="Actions.resolveDisputeFull('in_review')">Mark in-review</button>
        <button class="btn sm ghost" onclick="Actions.resolveDisputeFull('rejected')">Reject</button></div>` : '';
    UI.modal(`<h3>Dispute ${esc(dp.ticket_no)} <span class="tag ${esc(dp.status)}">${esc(dp.status)}</span></h3>
      <div class="muted" style="font-size:12px">Ref ${esc(dp.reference||'—')} · ${esc((dp.category||'').replace(/_/g,' '))}${isAdmin&&dp.raised_by_name?' · by '+esc(dp.raised_by_name):''}</div>
      <div style="max-height:300px;overflow:auto;margin-top:10px">${thread || '<div class="muted">No messages.</div>'}</div>
      ${open ? `<div class="field mt"><label>Add a reply</label><div class="row" style="gap:8px">
        <input id="dp_msg" placeholder="Type a message…" style="flex:1" onkeydown="if(event.key==='Enter')Actions.addDisputeMsg()">
        <button class="btn sm" onclick="Actions.addDisputeMsg()">Send</button></div></div>` : ''}
      ${open ? staffPanel : (dp.resolution?`<div class="msg ok mt">Resolution: ${esc(dp.resolution)}</div>`:'')}
      <div class="foot"><button class="btn ghost" onclick="Actions.printDisputeReceipt()">🧾 Print receipt</button>
        <button class="btn ghost" onclick="UI.closeModal()">Close</button></div>`);
  },
  async addDisputeMsg() {
    const { id, isAdmin } = Actions._dispCtx || {}; const m = ($('dp_msg')||{}).value || '';
    if (!m.trim()) return;
    const base = isAdmin ? '/admin/disputes/' + id + '/messages' : '/disputes/' + id + '/messages';
    try { await Api.post(base, { message: m.trim() }); Actions.viewDispute(id, isAdmin); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async resolveDisputeFull(status) {
    const { id } = Actions._dispCtx || {};
    const resolution = ($('dp_res')||{}).value || '';
    if (!resolution.trim()) return UI.toast('Enter a resolution note', 'err');
    const refund = !!($('dp_refund')||{}).checked;
    try { await Api.post(`/admin/disputes/${id}/resolve`, { status, resolution: resolution.trim(), refund });
      UI.closeModal(); UI.toast('Dispute ' + status + (refund?' + refunded':'')); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async printDisputeReceipt() {
    const { id, isAdmin } = Actions._dispCtx || {};
    const base = isAdmin ? '/admin/disputes/' + id + '/receipt' : '/disputes/' + id + '/receipt';
    try { const res = await Api.raw(base); const html = await res.text(); const w = window.open('', '_blank'); w.document.write(html); w.document.close(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async refundTxn(id) {
    const remark = prompt('Refund this transaction — enter a reason (required):', '');
    if (remark === null) return;
    if (!remark.trim()) return UI.toast('A reason is required', 'err');
    if (!confirm('Refund the payer and claw back commission for this transaction?')) return;
    try { await Api.post(`/admin/transactions/${id}/refund`, { remark: remark.trim() }); UI.toast('Refunded'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },

  // Admin: risk & AML flagged events.
  async risk() {
    const d = await Api.get('/admin/risk-events?limit=80');
    const badge = (a) => a === 'block' ? '<span class="tag blocked">block</span>'
      : a === 'hold' ? '<span class="tag" style="background:#fef3c7;color:#92400e">hold</span>'
      : '<span class="tag" style="background:#e0e7ff;color:#3730a3">review</span>';
    const rows = d.items.map(r => `<tr>
      <td>${esc(r.full_name||'—')}</td><td>${esc(r.service_code||'')}</td><td>${esc(r.kind)}</td>
      <td class="right">${r.score}</td><td>${badge(r.action)}</td>
      <td class="muted">${esc(JSON.stringify(r.detail||{}))}</td>
      <td class="muted">${new Date(r.created_at).toLocaleString('en-IN')}</td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><h2>Risk &amp; AML events</h2>
      <p class="muted">Velocity, off-hours, AePS split (commission stripped) and DMT structuring (blocked) flags.</p>
      <div class="tbl-wrap"><table>
      <thead><tr><th>Member</th><th>Service</th><th>Kind</th><th class="right">Score</th><th>Action</th><th>Detail</th><th>When</th></tr></thead>
      <tbody>${rows || '<tr><td colspan=7 class=muted>No flags</td></tr>'}</tbody></table></div></div>`;
  },

  // Admin: website branding + custom pages CMS.
  async website() {
    const [st, pg] = await Promise.all([Api.get('/admin/site/settings'), Api.get('/admin/site/pages')]);
    const s = {}; st.items.forEach(r => s[r.key] = r.value || '');
    const field = (k, label, ph = '') => `<div class="field"><label>${label}</label><input id="ws_${k}" value="${esc(s[k]||'')}" placeholder="${ph}"></div>`;
    // URL field + a file picker that uploads a photo (stored inline, downscaled).
    const imgField = (k, label, ph = '') => `<div class="field"><label>${label}</label>
      <input id="ws_${k}" value="${esc(s[k]||'')}" placeholder="${ph}">
      <div class="row" style="gap:8px;align-items:center;margin-top:6px">
        <input type="file" accept="image/*" id="up_${k}" onchange="Actions.uploadImage('${k}', this)" style="font-size:12px">
        <span id="upmsg_${k}" class="muted" style="font-size:12px"></span>
        ${s[k] ? `<img src="${esc(s[k])}" alt="" style="height:34px;border-radius:6px;border:1px solid var(--line)">` : ''}
      </div></div>`;
    const prows = pg.items.map(p => `<tr><td>${esc(p.slug)}</td><td>${esc(p.title)}</td>
      <td>${p.published ? '<span class="tag active">live</span>' : '<span class="tag blocked">draft</span>'}</td>
      <td><a class="btn sm ghost" href="../page.html?slug=${encodeURIComponent(p.slug)}" target="_blank">View</a>
          <button class="btn sm" onclick="Actions.editPage('${p.slug}')">Edit</button>
          <button class="btn sm ghost" onclick="Actions.deletePage('${p.slug}')">Delete</button></td></tr>`).join('');
    $('view').innerHTML = `
      <div class="panel" style="max-width:640px"><h2>Branding</h2>
        <p class="muted">Applies to the landing site and this panel (name, logo, colour, contacts). Leave logo URL blank to use the emoji.</p>
        ${field('brand_name','Brand name','TutiPays')}
        ${field('logo_emoji','Logo emoji','₹')}
        ${imgField('logo_url','Logo image (URL or upload)','https://…')}
        ${field('primary_color','Primary colour (hex)','#3b39e4')}
        ${field('tagline','Tagline')}
        ${field('support_email','Support email')}
        ${field('admin_email','Admin email')}
        ${field('phone','Phone')}
        <h2 class="mt">Company details</h2>
        ${field('company_name','Legal name')}
        ${field('company_address','Registered address')}
        <h2 class="mt">Login / Sign-up offer poster</h2>
        <p class="muted">Shown beside the login and sign-up forms. Leave image URL blank for the default gradient.</p>
        ${imgField('auth_poster_url','Poster image (URL or upload)','https://…/offer.jpg')}
        ${field('auth_poster_title','Poster title','Grow your business with us')}
        ${field('auth_poster_subtitle','Poster subtitle')}
        ${field('auth_poster_link','Poster link (optional)','https://…')}
        <h2 class="mt">Security policy</h2>
        <div class="field"><label><input type="checkbox" id="ws_security_require_txn_mpin" ${s.security_require_txn_mpin==='true'?'checked':''}> Require MPIN to confirm every transaction</label></div>
        <p class="muted">When on, retailers must enter their MPIN (set in Security) to complete each money transaction. They'll be prompted automatically.</p>
        <div class="field"><label><input type="checkbox" id="ws_security_require_signup_otp" ${s.security_require_signup_otp==='true'?'checked':''}> Require mobile OTP verification at sign-up</label></div>
        <p class="muted">When on, new users must verify their mobile with an OTP before their account is created. Configure the SMS/OTP gateway in <b>Integrations</b> first.</p>
        <div class="field"><label><input type="checkbox" id="ws_security_require_kyc" ${s.security_require_kyc==='true'?'checked':''}> Require KYC verification before a member can transact</label></div>
        <p class="muted">When on, any member whose KYC is not <b>verified</b> is blocked from every money transaction (they'll be told to complete KYC). Review submissions under <a href="#/kycreview">KYC Review</a>.</p>
        ${field('security_admin_ip_allowlist','Admin login IP allowlist','1.2.3.4, 10.0.0.0/24 — blank = any')}
        <p class="muted">Restrict super-admin logins to these IPs/CIDRs (comma-separated). Leave blank to allow admin login from anywhere. The admin portal lives at a separate URL (<code>/admin</code>); this allowlist is the real lock behind it.</p>
        <h2 class="mt">Member notifications (SMS)</h2>
        <p class="muted">Send members an SMS on key events. Requires an active SMS gateway under <a href="#/integrations">Integrations</a>.</p>
        <div class="field"><label><input type="checkbox" id="ws_notify_txn_sms" ${s.notify_txn_sms==='true'?'checked':''}> Transaction alerts (success / failed) with reference</label></div>
        <div class="field"><label><input type="checkbox" id="ws_notify_low_balance" ${s.notify_low_balance==='true'?'checked':''}> Low wallet-balance alert (once, when it drops below the threshold)</label></div>
        ${field('low_balance_threshold','Low-balance threshold (₹)','500')}
        <div class="field"><label><input type="checkbox" id="ws_notify_kyc" ${s.notify_kyc==='true'?'checked':''}> KYC status alert (verified / rejected)</label></div>
        <h2 class="mt">Transaction safety</h2>
        <p class="muted">Block an accidental <b>duplicate</b> transaction — the same member sending the same service, amount and details (account / VPA / consumer no.) again within this window. Set the minutes below; <b>0</b> turns the guard off. A previous <i>failed</i> attempt never blocks a retry.</p>
        ${field('duplicate_txn_window_minutes','Duplicate-block window (minutes)','5')}
        <p class="muted mt">Default resolution <b>SLA</b> for disputes (hours). The desk flags anything past its deadline as overdue. Money-stuck complaints (not credited / double charge / wrong amount) auto-use a tighter 12h target.</p>
        ${field('dispute_sla_hours','Dispute SLA (hours)','24')}
        <p class="muted mt"><b>Auto-reconciliation</b> — automatically fail &amp; refund transactions stuck in <i>pending</i> for this many hours (the provider never sent a final status). <b>0</b> = off. Runs in the background; you can also sweep manually under Reconciliation.</p>
        ${field('auto_recon_hours','Auto-recon after (hours, 0 = off)','0')}
        <h2 class="mt">Webhooks &amp; callbacks</h2>
        <p class="muted">Give these callback URLs to your payout / DMT / recharge provider. The aggregator secret below signs incoming callbacks (HMAC-SHA256).</p>
        <div class="field"><label>Aggregator callback URL</label><input value="${esc(location.origin)}/api/v1/webhooks/aggregator" readonly onclick="this.select()"></div>
        <div class="field"><label>Razorpay callback URL</label><input value="${esc(location.origin)}/api/v1/webhooks/razorpay" readonly onclick="this.select()"></div>
        ${field('aggregator_webhook_secret','Aggregator webhook secret (HMAC key)')}
        <h2 class="mt">Automation (n8n / AI agent)</h2>
        <p class="muted">Platform events (disputes, etc.) are POSTed to this URL as <code>{event, at, data}</code> — wire it to an n8n workflow or an AI-agent that acts as staff.</p>
        ${field('automation_webhook_url','Automation / n8n webhook URL','https://n8n.yourhost/webhook/…')}
        <h2 class="mt">SEO &amp; Analytics</h2>
        <p class="muted">Search-engine defaults for the public site and your analytics tag. These apply on every marketing page.</p>
        ${field('meta_description','Meta description (search snippet)','TutiPays — one wallet for recharge, AEPS, money transfer, bills and more.')}
        ${field('meta_keywords','Meta keywords (comma separated)','AEPS, DMT, recharge, BBPS, payout, retailer')}
        ${field('og_image_url','Social share image URL (1200×630)','https://tutipays.com/og-image.svg')}
        ${field('google_analytics_id','Google Analytics ID (GA4, e.g. G-XXXXXXX)','')}
        <h2 class="mt">Social links</h2>
        <p class="muted">Shown in the site footer when set.</p>
        ${field('social_facebook','Facebook URL','https://facebook.com/…')}
        ${field('social_instagram','Instagram URL','https://instagram.com/…')}
        ${field('social_twitter','X / Twitter URL','https://x.com/…')}
        ${field('social_youtube','YouTube URL','https://youtube.com/@…')}
        ${field('social_whatsapp','WhatsApp number (with country code)','9198xxxxxxx')}
        <button class="btn mt" onclick="Actions.saveSite()">Save settings</button></div>
      <div class="panel mt"><div class="row" style="justify-content:space-between"><h2>Custom pages</h2>
        <button class="btn sm" onclick="Actions.editPage()">+ New page</button></div>
        <p class="muted">Author extra pages (e.g. Careers, Offers). They render at <code>/page.html?slug=…</code>.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Slug</th><th>Title</th><th>Status</th><th></th></tr></thead>
        <tbody>${prows || '<tr><td colspan=4 class=muted>No custom pages yet</td></tr>'}</tbody></table></div></div>`;
  },

  // Admin: platform integrations (SMS / email / OTP / Aadhaar / PAN / penny-drop).
  async integrations() {
    const d = await Api.get('/admin/integrations');
    const rows = d.items.map(i => `<tr>
      <td>${esc(i.label)}</td><td class="muted">${esc(i.category)}</td><td>${esc(i.provider||'')}</td>
      <td>${i.has_key ? '🔑' : '<span class="muted">no key</span>'}</td>
      <td>${i.is_active ? '<span class="tag active">active</span>' : '<span class="tag blocked">off</span>'}</td>
      <td><button class="btn sm" onclick="Actions.editIntegration('${i.key}','${esc(i.label)}','${esc(i.provider||'')}','${esc(i.base_url||'')}','${esc(i.sender_id||'')}',${i.is_active})">Configure</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><h2>Platform integrations</h2>
      <p class="muted">Paste API keys for messaging &amp; identity services. Keys are write-only (shown masked). Mark active to enable.</p>
      <div class="tbl-wrap"><table>
      <thead><tr><th>Service</th><th>Category</th><th>Provider</th><th>Key</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  },

  // Admin: AI Integration Studio — draft a config-driven provider from docs,
  // self-test the mapping, then save & activate. No developer, no code deploy.
  async aistudio() {
    const svcs = await Api.get('/admin/services').catch(() => ({ items: [] }));
    const ints = await Api.get('/admin/integrations').catch(() => ({ items: [] }));
    const ai = (ints.items || []).find(i => i.key === 'ai_coder');
    const codes = (svcs.items || []).map(s => s.code);
    const svcChecks = codes.map(c => `<label style="display:inline-flex;align-items:center;gap:5px;margin:2px 8px 2px 0;font-size:13px">
      <input type="checkbox" class="ai_svc" value="${esc(c)}" ${['payout','recharge','bbps','dmt'].includes(c)?'checked':''}> ${esc(c)}</label>`).join('');
    $('view').innerHTML = `
      <div class="panel"><h2>🤖 AI model</h2>
        <p class="muted">Point this at any OpenAI-compatible endpoint <b>or</b> an n8n webhook that runs a free model. The model name is just text — when your free model updates, change it here. In n8n mode the model lives in your workflow.</p>
        <div class="row">
          <div class="field"><label>Mode</label><select id="ai_mode">
            <option value="openai" ${ai&&ai.provider==='n8n'?'':'selected'}>OpenAI-compatible</option>
            <option value="n8n" ${ai&&ai.provider==='n8n'?'selected':''}>n8n webhook (free AI)</option></select></div>
          <div class="field" style="flex:2;min-width:260px"><label>Base URL / n8n webhook</label><input id="ai_url" value="${esc(ai?.base_url||'')}" placeholder="https://api.groq.com/openai/v1  or  https://n8n.you/webhook/ai"></div>
        </div>
        <div class="row">
          <div class="field" style="flex:2"><label>API key ${ai?.has_key?'<span class="tag active">set</span>':''}</label><input id="ai_key" type="password" placeholder="${ai?.has_key?'•••••• (leave blank to keep)':'Bearer key (optional for open n8n)'}"></div>
          <div class="field"><label>Model</label><input id="ai_model" value="${esc(ai?.provider && ai.provider!=='n8n' ? ai.provider : '')}" placeholder="llama-3.3-70b-versatile"></div>
        </div>
        <button class="btn" onclick="Actions.aiSaveModel()">Save AI settings</button>
        <span class="muted" style="margin-left:10px;font-size:12px">${ai?.is_active?'✅ AI is configured':'Not configured — the studio will still give you a fillable template.'}</span>
        <div class="msg" style="margin-top:12px;background:#eef2ff">
          🧩 <b>Using n8n with a free model?</b> Import our ready-made workflow, set its model + key, activate it, and paste its Production webhook URL above (mode: n8n).
          <a href="/n8n-ai-provider-generator.json" download style="margin-left:6px">Download n8n workflow →</a>
        </div>
      </div>

      <div class="panel mt"><h2>Build a provider from its API docs</h2>
        <p class="muted">Paste the provider's API documentation, choose the services, and generate a ready-to-test integration config — no code.</p>
        <div class="field"><label>Services to map</label><div>${svcChecks || '<span class="muted">No services</span>'}</div></div>
        <div class="field"><label>Paste API docs / sample request &amp; response</label>
          <textarea id="ai_docs" rows="8" style="width:100%;font-family:ui-monospace,monospace;font-size:12px" placeholder="Base URL, auth headers, endpoint paths, request fields, response fields, status values…"></textarea></div>
        <button class="btn" onclick="Actions.aiDraft()">✨ Generate config</button>
        <div id="ai_out"></div>
      </div>`;
  },

  // Admin: AI Dev Desk — file feature/bug requests, AI drafts the plan,
  // approve to dispatch to automation. No developer spend.
  async devdesk() {
    const d = await Api.get('/admin/devdesk').catch(() => ({ items: [] }));
    const kindIco = { feature:'✨', bug:'🐞', ui:'🎨' };
    const rows = (d.items || []).map(r => `<tr>
      <td class="mono">${esc(r.ticket_no||'')}</td>
      <td>${kindIco[r.kind]||'•'} ${esc(r.title)}<div class="muted" style="font-size:11.5px">${esc(r.area||'')}${r.created_by_name?' · by '+esc(r.created_by_name):''}</div></td>
      <td><span class="tag ${r.priority==='urgent'||r.priority==='high'?'pending':'active'}">${esc(r.priority)}</span></td>
      <td>${UI.statusTag(r.status)}</td>
      <td><button class="btn sm ghost" onclick="Actions.viewDev('${r.id}')">Open</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between">
        <h2>🛠️ AI Dev Desk</h2><button class="btn sm" onclick="Actions.newDev()">＋ New request</button></div>
        <p class="muted">File a feature request or bug. The AI drafts exactly what to build or fix (the plan), you approve it, and it's dispatched to your automation (n8n / coding agent) to open a PR — nothing is auto-deployed. Configure the AI under <a href="#/aistudio">AI Integration Studio</a>.</p>
        <div class="msg" style="background:#eef2ff">🤖 <b>Turnkey dev agent:</b> import the ready-made n8n workflow that receives an approval, runs the free AI, and opens a draft PR. Set its GitHub token + AI model, then paste its webhook URL into <a href="#/website">Website → Automation webhook</a>.
          <a href="/n8n-dev-agent.json" download style="margin-left:6px">Download dev-agent workflow →</a></div>
        <div class="tbl-wrap"><table><thead><tr><th>Ticket</th><th>Request</th><th>Priority</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan=5 class=muted>No requests yet — file the first one.</td></tr>'}</tbody></table></div></div>`;
  },

  // Admin: T+1 settlement report — per-member daily summary.
  async settlement() {
    const date = Actions._settleDate || '';
    const d = await Api.get('/admin/settlement-report' + (date ? '?date=' + date : '')).catch(() => ({ items: [], totals: {} }));
    const t = d.totals || {};
    const rows = (d.items || []).map(x => `<tr>
      <td>${esc(x.full_name)}<div class="muted" style="font-size:11px">${esc(x.role)} · ${esc(x.phone||'')}</div></td>
      <td class="right">${x.txns}</td>
      <td class="right">${money((x.gtv_paise||0)/100)}</td>
      <td class="right comm-pos">${money((x.commission_paise||0)/100)}</td>
      <td class="right">${money((x.charge_paise||0)/100)}</td></tr>`).join('');
    $('view').innerHTML = `<div class="panel">
      <div class="row" style="justify-content:space-between;align-items:end">
        <div><h2 style="margin:0">Settlement report</h2><p class="muted" style="margin:2px 0 0">Per-member summary of successful transactions for <b>${esc(d.date||'yesterday')}</b> (T+1). Blank date = yesterday.</p></div>
        <div class="row" style="gap:8px;align-items:end">
          <div class="field" style="margin:0"><label>Date</label><input id="se_date" type="date" value="${esc(date)}" onchange="Actions._settleDate=this.value;App.route()"></div>
          <button class="btn sm" onclick="Actions.dl('/admin/settlement-report?format=csv'+(Actions._settleDate?'&date='+Actions._settleDate:''),'settlement.csv')">⬇ CSV</button>
        </div></div>
      <div class="stats mt">
        ${UI.stat('b','🧾','Transactions', t.txns||0, 'Successful, that day')}
        ${UI.stat('t','💳','GTV', money((t.gtv_paise||0)/100), 'Successful value')}
        ${UI.stat('g','💰','Commission', money((t.commission_paise||0)/100), 'Paid to the network')}
        ${UI.stat('o','🏦','Charges', money((t.charge_paise||0)/100), 'Collected')}
      </div>
      <div class="tbl-wrap mt"><table>
        <thead><tr><th>Member</th><th class="right">Txns</th><th class="right">GTV</th><th class="right">Commission</th><th class="right">Charges</th></tr></thead>
        <tbody>${rows || '<tr><td colspan=5 class=muted>No settled transactions for this day.</td></tr>'}</tbody></table></div></div>`;
  },

  // Admin: manage upstream providers per service (multiple, one active).
  async providers() {
    const svcs = await Api.get('/admin/services');
    const codes = svcs.items.map(s => s.code);
    const sel = Actions._provService && codes.includes(Actions._provService) ? Actions._provService : codes[0];
    const opts = svcs.items.map(s => `<option value="${s.code}" ${s.code===sel?'selected':''}>${esc(s.code)} — ${esc(s.name)}</option>`).join('');
    const list = await Api.get(`/admin/services/${sel}/providers`);
    const rows = list.items.map(p => `<tr>
      <td>${esc(p.label)}</td><td>${esc(p.driver)}</td><td class="muted">${esc(p.base_url||'')}</td>
      <td>${p.is_active ? '<span class="tag active">active</span>' : ''}</td>
      <td>${p.api_key ? '••••' : '<span class="muted">no key</span>'}</td>
      <td><button class="btn sm ghost" onclick="Actions.testProvider('${p.id}','${esc(p.label)}')">Test</button>
          ${p.is_active
          ? `<button class="btn sm ghost" onclick="Actions.deactivateProvider('${p.id}')">Deactivate</button>`
          : `<button class="btn sm" onclick="Actions.activateProvider('${p.id}')">Activate</button>`}
          <button class="btn sm ghost" onclick="Actions.deleteProvider('${p.id}')">Delete</button></td></tr>
      <tr class="subrow"><td colspan="6" style="background:#f7f8fb">
        <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
          <span class="muted" style="font-size:12px">Callback URL (give this to ${esc(p.label)}):</span>
          <code style="font-size:12px;word-break:break-all">${esc(p.callback_url)}</code>
          <button class="btn sm ghost" onclick="Actions.copyText('${esc(p.callback_url)}')">Copy</button>
          <span class="tag ${p.has_webhook_secret?'active':''}" style="font-size:11px">${p.has_webhook_secret?'secret set':'shared secret'}</span>
          <button class="btn sm ghost" onclick="Actions.editProviderSecret('${p.id}','${esc(p.label)}')">Set secret</button>
        </div></td></tr>`).join('');
    const gl = await Api.get('/admin/go-live').catch(() => null);
    const glCard = gl ? `<div class="box" style="background:#f7f8fb;border:1px solid #e5e9f2;border-radius:10px;padding:12px 16px;margin-bottom:14px">
      <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <b>Go-live readiness</b>
        <div class="row" style="gap:8px;font-size:12px">
          <span class="tag active">${gl.live_count} live</span>
          <span class="tag" style="background:#fef7e0;color:#b26a00">${gl.sandbox_count} sandbox</span>
          ${gl.none_count?`<span class="tag" style="background:#fce8e6;color:#c5221f">${gl.none_count} none</span>`:''}
        </div></div>
      <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:8px">
        ${gl.items.map(i=>`<span class="tag ${i.status==='live'?'active':''}" style="font-size:11px;${i.status==='sandbox'?'background:#fef7e0;color:#b26a00':i.status==='none_active'?'background:#fce8e6;color:#c5221f':''}" title="${esc(i.active_provider||'no active provider')}">${esc(i.service_code)}: ${i.status==='live'?'live':i.status}</span>`).join('')}
      </div></div>` : '';
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between">
      <h2>Service providers</h2><button class="btn sm" onclick="Actions.addProvider('${sel}')">+ Add provider</button></div>
      ${glCard}
      <div class="field" style="max-width:360px"><label>Service</label>
        <select id="prov_svc" onchange="Actions._provService=this.value;App.route()">${opts}</select></div>
      <p class="muted">Register one or more providers per service and activate the one to route through. Paste API keys here — going live is just adding keys and activating. Each provider has its <b>own callback URL</b> below — give it to that provider so status updates (success / pending / failed) post back and settle automatically for every service.</p>
      <div class="tbl-wrap"><table>
      <thead><tr><th>Label</th><th>Driver</th><th>Base URL</th><th>Active</th><th>Key</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=6 class=muted>No providers — add one</td></tr>'}</tbody></table></div></div>`;
  },

  // Admin: business analytics — GTV/revenue trend, service mix, top members.
  async analytics() {
    const days = Actions._anDays || 30;
    const d = await Api.get('/analytics/platform?days=' + days);
    const gtv = d.daily.map(x => x.gtv_paise / 100);
    const rev = d.daily.map(x => x.revenue_paise / 100);
    const labels = d.daily.map(x => x.day.slice(5));
    const mixTotal = d.service_mix.reduce((a, s) => a + s.gtv_paise, 0) || 1;
    const rangeBtns = [7, 30, 90].map(n => `<button class="btn sm ${days===n?'':'ghost'}" onclick="Actions._anDays=${n};App.route()">${n}d</button>`).join(' ');
    $('view').innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Analytics</h2><div class="row" style="gap:6px">${rangeBtns}</div></div>
      <div class="grid cards mt">
        ${UI.stat('a','💸','GTV ('+days+'d)', money(d.totals.gtv_paise/100))}
        ${UI.stat('b','🏦','Platform revenue', money(d.totals.revenue_paise/100))}
        ${UI.stat('c','🧾','Transactions', d.totals.count)}
      </div>
      <div class="panel mt"><h2>Gross transaction value (daily)</h2>${barChart(gtv, labels, v => '₹'+v.toLocaleString('en-IN'))}</div>
      <div class="panel mt"><h2>Platform revenue (daily)</h2>${barChart(rev, labels, v => '₹'+v.toLocaleString('en-IN'))}</div>
      <div class="panel mt"><h2>Service mix</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Service</th><th class="right">Txns</th><th class="right">GTV</th><th>Share</th></tr></thead>
        <tbody>${d.service_mix.map(s => `<tr><td>${esc(s.service)}</td><td class="right">${s.count}</td>
          <td class="right">${money(s.gtv_paise/100)}</td>
          <td><div style="background:#eef1f8;border-radius:4px;height:10px;width:120px;overflow:hidden"><div style="background:#3d43e0;height:10px;width:${Math.round(s.gtv_paise/mixTotal*100)}%"></div></div></td></tr>`).join('') || '<tr><td colspan=4 class=muted>No data</td></tr>'}</tbody></table></div></div>
      <div class="panel mt"><h2>Top members by GTV</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Member</th><th>Role</th><th class="right">Txns</th><th class="right">GTV</th></tr></thead>
        <tbody>${d.top_members.map(m => `<tr><td>${esc(m.full_name)}</td><td>${esc((m.role||'').replace(/_/g,' '))}</td>
          <td class="right">${m.count}</td><td class="right">${money(m.gtv_paise/100)}</td></tr>`).join('') || '<tr><td colspan=4 class=muted>No data</td></tr>'}</tbody></table></div></div>`;
  },

  // Member: my earnings + activity analytics.
  async myearnings() {
    const days = Actions._anDays || 30;
    const d = await Api.get('/analytics/me?days=' + days);
    const earned = d.daily.map(x => x.earned_paise / 100);
    const gtv = d.daily.map(x => x.gtv_paise / 100);
    const labels = d.daily.map(x => x.day.slice(5));
    const mixTotal = d.service_mix.reduce((a, s) => a + s.gtv_paise, 0) || 1;
    const rangeBtns = [7, 30, 90].map(n => `<button class="btn sm ${days===n?'':'ghost'}" onclick="Actions._anDays=${n};App.route()">${n}d</button>`).join(' ');
    $('view').innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">My Earnings</h2><div class="row" style="gap:6px">${rangeBtns}</div></div>
      <div class="grid cards mt">
        ${UI.stat('a','🎁','Commission earned ('+days+'d)', money(d.totals.earned_paise/100))}
        ${UI.stat('b','💸','My volume (GTV)', money(d.totals.gtv_paise/100))}
        ${UI.stat('c','🧾','Transactions', d.totals.count)}
      </div>
      <div class="panel mt"><h2>Commission earned (daily)</h2>${barChart(earned, labels, v => '₹'+v.toLocaleString('en-IN'))}</div>
      <div class="panel mt"><h2>My transaction volume (daily)</h2>${barChart(gtv, labels, v => '₹'+v.toLocaleString('en-IN'))}</div>
      <div class="panel mt"><h2>My service mix</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Service</th><th class="right">Txns</th><th class="right">Volume</th><th>Share</th></tr></thead>
        <tbody>${d.service_mix.map(s => `<tr><td>${esc(s.service)}</td><td class="right">${s.count}</td>
          <td class="right">${money(s.gtv_paise/100)}</td>
          <td><div style="background:#eef1f8;border-radius:4px;height:10px;width:120px;overflow:hidden"><div style="background:#3d43e0;height:10px;width:${Math.round(s.gtv_paise/mixTotal*100)}%"></div></div></td></tr>`).join('') || '<tr><td colspan=4 class=muted>No activity yet</td></tr>'}</tbody></table></div></div>`;
  },

  // Admin: recharge operator + BBPS biller catalog. Members' dropdowns read
  // the enabled rows here — manage the lists without a deploy.
  async catalog() {
    const [ops, bills] = await Promise.all([Api.get('/admin/operators'), Api.get('/admin/billers')]);
    const orow = (ops.items || []).map(o => `<tr>
      <td class="mono">${esc(o.code)}</td><td>${esc(o.name)}</td><td>${esc(o.type)}</td>
      <td>${o.enabled ? '<span class="tag active">on</span>' : '<span class="tag">off</span>'}</td>
      <td class="right">
        <button class="btn sm ghost" onclick="Actions.toggleOperator('${esc(o.code)}',${!o.enabled})">${o.enabled?'Disable':'Enable'}</button>
        <button class="btn sm ghost" onclick="Actions.delOperator('${esc(o.code)}')">Delete</button></td></tr>`).join('');
    const brow = (bills.items || []).map(b => `<tr>
      <td class="mono">${esc(b.biller_id)}</td><td>${esc(b.name)}</td><td>${esc(b.category)}</td><td>${esc(b.coverage||'')}</td>
      <td>${b.enabled ? '<span class="tag active">on</span>' : '<span class="tag">off</span>'}</td>
      <td class="right">
        <button class="btn sm ghost" onclick="Actions.toggleBiller('${esc(b.biller_id)}',${!b.enabled})">${b.enabled?'Disable':'Enable'}</button>
        <button class="btn sm ghost" onclick="Actions.delBiller('${esc(b.biller_id)}')">Delete</button></td></tr>`).join('');
    $('view').innerHTML = `
      <div class="panel"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Recharge operators</h2>
        <button class="btn sm" onclick="Actions.addOperator()">+ Add operator</button></div>
        <p class="muted">Prepaid / postpaid / DTH operators shown to members on the Recharge form.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Status</th><th></th></tr></thead>
        <tbody>${orow || '<tr><td colspan=5 class=muted>No operators</td></tr>'}</tbody></table></div></div>
      <div class="panel mt"><div class="row" style="justify-content:space-between"><h2 style="margin:0">BBPS billers</h2>
        <button class="btn sm" onclick="Actions.addBiller()">+ Add biller</button></div>
        <p class="muted">Biller directory shown on the BBPS form, grouped by category.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Biller ID</th><th>Name</th><th>Category</th><th>Coverage</th><th>Status</th><th></th></tr></thead>
        <tbody>${brow || '<tr><td colspan=6 class=muted>No billers</td></tr>'}</tbody></table></div></div>`;
  },
};

// ---------------- Service definitions for the "New transaction" form ----------------
const SERVICES = [
  { key: 'recharge', label: 'Recharge', path: '/recharge', provider: true, fields: [
    ['recharge_type', 'Type', 'select', ['prepaid', 'postpaid', 'dth']],
    ['operator', 'Operator', 'select', ['Jio', 'Airtel', 'Vi', 'BSNL', 'Tata Play (DTH)', 'Dish TV (DTH)', 'Airtel Digital TV (DTH)', 'd2h (DTH)', 'Sun Direct (DTH)']],
    ['number', 'Mobile / DTH number', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ operator: v.operator, number: v.number, amount: +v.amount, recharge_type: v.recharge_type || 'prepaid', ...(v.circle ? { circle: v.circle } : {}) }) },
  { key: 'dmt', label: 'DMT (bank transfer)', path: '/dmt', provider: true, fields: [
    ['beneficiary_name', 'Beneficiary name', 'text'], ['account_number', 'Account number', 'text'],
    ['ifsc', 'IFSC', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ beneficiary_name: v.beneficiary_name, account_number: v.account_number, ifsc: v.ifsc.toUpperCase(), amount: +v.amount, mode: 'IMPS' }) },
  { key: 'bbps', label: 'BBPS (bill pay)', path: '/bbps/pay', provider: true, fields: [
    ['biller_id', 'Biller ID', 'text'], ['consumer_number', 'Consumer number', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ biller_id: v.biller_id, consumer_number: v.consumer_number, amount: +v.amount }) },
  { key: 'payout', label: 'Payout', path: '/payout', provider: true, fields: [
    ['beneficiary_name', 'Beneficiary name', 'text'], ['account_number', 'Account number', 'text'],
    ['ifsc', 'IFSC', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ beneficiary_name: v.beneficiary_name, account_number: v.account_number, ifsc: v.ifsc.toUpperCase(), amount: +v.amount, mode: 'IMPS' }) },
  { key: 'upi', label: 'UPI payout', path: '/upi/pay', provider: true, fields: [
    ['vpa', 'UPI ID (name@bank)', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ vpa: v.vpa, amount: +v.amount }) },
  { key: 'cms', label: 'CMS (cash collection)', path: '/cms/pay', provider: true, fields: [
    ['agent_id', 'Agent / company ID', 'text'], ['account_number', 'Account number', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ agent_id: v.agent_id, account_number: v.account_number, amount: +v.amount }) },
  { key: 'aeps', label: 'AEPS cash withdrawal', path: '/aeps/cash-withdrawal', provider: true, biometric: true, fields: [
    ['aadhaar', 'Aadhaar number (12 digit)', 'text'], ['bank_iin', 'Bank IIN', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ aadhaar: v.aadhaar, bank_iin: v.bank_iin, amount: +v.amount }) },
  { key: 'matm', label: 'Micro ATM', path: '/matm/withdrawal', provider: true, fields: [['amount', 'Amount', 'number']],
    build: v => ({ amount: +v.amount }) },
  { key: 'aadhaar_pay', label: 'Aadhaar Pay', path: '/aadhaar-pay', provider: true, biometric: true, fields: [
    ['aadhaar', 'Aadhaar number (12 digit)', 'text'], ['bank_iin', 'Bank IIN', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ aadhaar: v.aadhaar, bank_iin: v.bank_iin, amount: +v.amount }) },
  { key: 'pan_card', label: 'PAN Card', path: '/pan-card/apply', provider: true, fields: [
    ['applicant_name', 'Applicant name', 'text'], ['amount', 'Fee', 'number'] ],
    build: v => ({ applicant_name: v.applicant_name, amount: +v.amount }) },
  { key: 'card_swipe', label: 'Card Swipe', path: '/card-swipe', provider: true, fields: [['amount', 'Amount', 'number']],
    build: v => ({ amount: +v.amount, card_type: 'debit' }) },
  { key: 'wallet_transfer', label: 'Wallet transfer (to member)', path: '/wallet-transfer', fields: [
    ['to', 'To (phone / email / username)', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ to: v.to, amount: +v.amount }) },
  { key: 'travel', label: 'Travel booking', path: '/travel/book', provider: true, fields: [
    ['booking_type', 'Type (flight/bus/train/hotel)', 'text'], ['operator', 'Operator', 'text'],
    ['from_location', 'From', 'text'], ['to_location', 'To', 'text'],
    ['passenger_name', 'Passenger', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ booking_type: v.booking_type || 'flight', operator: v.operator, from_location: v.from_location,
      to_location: v.to_location, passenger_name: v.passenger_name, amount: +v.amount }) },
  { key: 'insurance', label: 'Insurance', path: '/insurance/buy', provider: true, fields: [
    ['category', 'Category (motor/health/life/travel)', 'text'], ['insurer', 'Insurer', 'text'],
    ['customer_name', 'Customer', 'text'], ['amount', 'Premium', 'number'] ],
    build: v => ({ category: v.category || 'health', insurer: v.insurer, customer_name: v.customer_name, amount: +v.amount }) },
  { key: 'loan', label: 'Loan Repayment', path: '/loan/pay', provider: true, fields: [
    ['lender', 'Lender / NBFC', 'text'], ['loan_account_no', 'Loan account number', 'text'],
    ['customer_name', 'Customer', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ lender: v.lender, loan_account_no: v.loan_account_no, customer_name: v.customer_name, amount: +v.amount }) },
  { key: 'credit_card', label: 'Credit Card Bill', path: '/credit-card/pay', provider: true, fields: [
    ['issuer', 'Card-issuing bank', 'text'], ['card_number', 'Card number', 'text'],
    ['customer_name', 'Card holder', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ issuer: v.issuer, card_number: v.card_number, customer_name: v.customer_name, amount: +v.amount }) },
];

// ---------------- Dashboard helpers ----------------
const SVC_ICON = {
  recharge:'📱', dmt:'🏦', payout:'💸', upi:'🔷', bbps:'🧾', aeps:'👆', matm:'🏧',
  aadhaar_pay:'🪪', card_swipe:'💳', cms:'💵', pan_card:'🆔', travel:'✈️', insurance:'🛡️',
  wallet_transfer:'🔁', payment_gateway:'💳', loan:'🏦', credit_card:'💳',
};
const svcIcon = (k) => SVC_ICON[k] || '💠';
const svcLabel = (k) => (SERVICES.find(s => s.key === k)?.label) || String(k || '').replace(/_/g,' ');
const timeAgo = (iso) => {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime())/1000));
  if (s < 60) return s+'s ago'; if (s < 3600) return Math.floor(s/60)+'m ago';
  if (s < 86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago';
};
// A row of service tiles linking into the New-transaction form.
const svcTiles = (keys) => `<div class="svc-grid">${keys.map(k => {
  const s = SERVICES.find(x => x.key === k); if (!s) return '';
  return `<a class="svc-tile" href="#/new" onclick="Actions.presetSvc('${k}')"><span class="si">${svcIcon(k)}</span><b>${esc(s.label)}</b></a>`;
}).join('')}</div>`;
// Recent transactions as compact rows (from /transactions items).
const txnMiniRows = (items) => items.length ? items.map(t => `<div class="mini">
  <span class="mi">${svcIcon(t.service)}</span>
  <div class="mm"><b>${esc(svcLabel(t.service))}</b><span class="mono">${esc(t.reference || '')}</span> · <span>${timeAgo(t.created_at)}</span></div>
  <div class="ma">${money((t.amount_paise||0)/100)}<small>${UI.statusTag(t.status)}</small></div>
</div>`).join('') : '<div class="muted" style="padding:10px 0">No transactions yet.</div>';
// Open disputes as compact rows (from /disputes items).
const disputeMiniRows = (items) => items.length ? items.map(d => `<div class="mini">
  <span class="mi">🎫</span>
  <div class="mm"><b>${esc(d.category ? String(d.category).replace(/_/g,' ') : 'Dispute')}</b><span>${esc(d.ticket_no||'')} · ${esc(d.reference||'')}</span></div>
  <div class="ma"><small>${UI.statusTag(d.status)}</small></div>
</div>`).join('') : '<div class="muted" style="padding:10px 0">No open disputes. 🎉</div>';

// ---------------- Actions (buttons/forms) ----------------
const Actions = {
  _bio: null,
  _provider: null,
  svcFields() {
    const s = SERVICES.find(x => x.key === $('svc').value);
    Actions._bio = null;
    Actions._provider = null;
    // Optional helper UI injected above the fields (saved payees, biller picker).
    let html = '<div id="svc-enhance"></div>' + s.fields.map(([n, label, type, options]) => {
      if (type === 'select') {
        const opts = (options || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
        return `<div class="field"><label>${label}</label><select name="${n}">${opts}</select></div>`;
      }
      return `<div class="field"><label>${label}</label><input name="${n}" type="${type}" ${type==='number'?'step=0.01 min=0':''} /></div>`;
    }).join('');
    // Provider chooser: when the super admin has >1 live API for this service,
    // let the retailer pick which one (e.g. Recharge 1 / Recharge 2).
    if (s.provider) html += `<div class="field" id="prov-choose"></div>`;
    if (s.biometric) {
      html += `<div class="field"><label>Customer biometric (RD device)</label>
        <div class="row" style="gap:8px;align-items:center">
          <select id="bio_type" style="max-width:150px"><option value="FMR">Fingerprint</option><option value="IIR">Iris</option></select>
          <button type="button" class="btn sm" onclick="Actions.scanBiometric()">🖐 Scan &amp; capture</button>
        </div>
        <div id="bio-status" class="muted" style="margin-top:6px">Not captured. Plug in a UIDAI RD device and click Scan. (Sandbox provider accepts a submit without a device.)</div></div>`;
    }
    $('svc-fields').innerHTML = html;
    if (s.provider) Actions.loadProviders(s.key);
    Actions.enhanceSvc(s.key);
  },
  // Wire in extra helpers for specific services (saved payees, BBPS billers).
  async enhanceSvc(key) {
    const box = $('svc-enhance'); if (!box) return;
    if (key === 'dmt') {
      try {
        const d = await Api.get('/beneficiaries');
        const list = d.items || [];
        const opts = ['<option value="">— pick a saved payee —</option>']
          .concat(list.map(b => `<option value="${esc(b.id)}" data-n="${esc(b.name)}" data-a="${esc(b.account_number)}" data-i="${esc(b.ifsc)}">${esc(b.name)} · ${esc(b.account_number)}</option>`));
        box.innerHTML = `<div class="field"><label>Saved beneficiaries</label>
          <div class="row" style="gap:8px"><select id="ben_pick" onchange="Actions.fillBeneficiary(this)" style="flex:1">${opts.join('')}</select>
          <a class="btn sm ghost" href="#/beneficiaries">Manage</a></div>
          <label style="display:flex;gap:6px;align-items:center;margin-top:8px;font-size:12px"><input type="checkbox" id="ben_save"> Save this beneficiary for next time</label></div>`;
      } catch { box.innerHTML = ''; }
    } else if (key === 'bbps') {
      try {
        const c = await Api.get('/bbps/categories');
        const cats = (c.items || []).map(x => `<option value="${esc(x.category)}">${esc(x.category)} (${x.billers})</option>`).join('');
        box.innerHTML = `<div class="field"><label>Biller category</label>
          <select id="bbps_cat" onchange="Actions.loadBillers(this.value)"><option value="">— select —</option>${cats}</select></div>
          <div class="field" id="bbps_biller_wrap" style="display:none"><label>Biller</label>
          <select id="bbps_biller" onchange="document.querySelector('#svc-fields [name=biller_id]').value=this.value"></select></div>`;
      } catch { box.innerHTML = ''; }
    } else if (key === 'recharge') {
      // Feed the operator + circle dropdowns from the live catalog, and keep
      // the operator list in sync with the prepaid/postpaid/dth type.
      await Actions.loadOperators();
      const typeSel = document.querySelector('#svc-fields [name=recharge_type]');
      if (typeSel) typeSel.addEventListener('change', () => Actions.loadOperators());
      box.innerHTML = '';
    } else { box.innerHTML = ''; }
  },
  // Replace the recharge operator <select> with catalog options for the chosen
  // type, and add a Circle dropdown from the catalog.
  async loadOperators() {
    const opSel = document.querySelector('#svc-fields [name=operator]');
    if (!opSel) return;
    const type = (document.querySelector('#svc-fields [name=recharge_type]') || {}).value || 'prepaid';
    try {
      const d = await Api.get('/recharge/operators?type=' + encodeURIComponent(type));
      opSel.innerHTML = (d.items || []).map(o => `<option value="${esc(o.name)}">${esc(o.name)}</option>`).join('')
        || '<option value="">No operators</option>';
    } catch { /* leave the static options */ }
    // Circle only applies to prepaid/postpaid; render/remove a Circle select.
    const opField = opSel.closest('.field');
    let circleField = document.getElementById('rch_circle_field');
    if (type === 'dth') { if (circleField) circleField.remove(); return; }
    if (!circleField && opField) {
      try {
        const c = await Api.get('/recharge/circles');
        const opts = ['<option value="">— circle (optional) —</option>']
          .concat((c.items || []).map(x => `<option value="${esc(x.name)}">${esc(x.name)}</option>`)).join('');
        opField.insertAdjacentHTML('afterend',
          `<div class="field" id="rch_circle_field"><label>Circle</label><select name="circle">${opts}</select></div>`);
      } catch { /* no circle field */ }
    }
  },
  fillBeneficiary(sel) {
    const o = sel.selectedOptions[0]; if (!o || !o.value) return;
    const set = (n, v) => { const el = document.querySelector(`#svc-fields [name="${n}"]`); if (el) el.value = v; };
    set('beneficiary_name', o.dataset.n); set('account_number', o.dataset.a); set('ifsc', o.dataset.i);
  },
  async loadBillers(category) {
    const wrap = $('bbps_biller_wrap'); const sel = $('bbps_biller');
    if (!category) { wrap.style.display = 'none'; return; }
    try {
      const d = await Api.get('/bbps/billers?category=' + encodeURIComponent(category));
      sel.innerHTML = (d.items || []).map(b => `<option value="${esc(b.biller_id)}">${esc(b.name)}</option>`).join('') || '<option value="">No billers</option>';
      wrap.style.display = '';
      const first = sel.querySelector('option'); if (first) document.querySelector('#svc-fields [name=biller_id]').value = first.value;
    } catch { wrap.style.display = 'none'; }
  },
  // Fetch the live providers for a service and render a chooser when >1.
  async loadProviders(serviceKey) {
    const box = $('prov-choose'); if (!box) return;
    try {
      const d = await Api.get('/catalog/providers/' + encodeURIComponent(serviceKey));
      const list = d.providers || [];
      if (list.length < 2) { box.innerHTML = ''; return; } // 0/1 provider: nothing to choose
      Actions._provider = list[0].id;
      const btns = list.map((p, i) =>
        `<button type="button" class="btn sm ${i===0?'':'ghost'}" data-pid="${esc(p.id)}"
           onclick="Actions.pickProvider(this,'${esc(p.id)}')">${esc(p.label)}</button>`).join(' ');
      box.innerHTML = `<label>Route via provider</label><div class="row" style="gap:8px">${btns}</div>`;
    } catch { box.innerHTML = ''; }
  },
  pickProvider(btn, id) {
    Actions._provider = id;
    document.querySelectorAll('#prov-choose .btn').forEach(b => b.classList.toggle('ghost', b !== btn));
  },
  async scanBiometric() {
    const type = $('bio_type').value;
    $('bio-status').innerHTML = '<span class="muted">Scanning… place the finger / eye on the device.</span>';
    try {
      const r = await RDService.capture(type);
      Actions._bio = r;
      $('bio-status').innerHTML = `<span style="color:#137333">✔ Captured (${esc(type)})${r.rd_service ? ' · ' + esc(r.rd_service) : ''}</span>`;
    } catch (err) {
      Actions._bio = null;
      $('bio-status').innerHTML = `<span style="color:#c5221f">${esc(err.message)}</span>`;
    }
  },
  async submitTxn(mpin) {
    const s = SERVICES.find(x => x.key === $('svc').value);
    const v = {}; s.fields.forEach(([n]) => v[n] = document.querySelector(`#svc-fields [name="${n}"]`).value.trim());
    const body = s.build(v);
    if (s.biometric && Actions._bio) Object.assign(body, Actions._bio);
    if (s.provider && Actions._provider) body.provider_id = Actions._provider;
    if (mpin) body.mpin = mpin;
    $('txn-result').innerHTML = '<span class="muted">Processing…</span>';
    try {
      const d = await Api.post(s.path, body);
      const t = d.transaction || d.transfer;
      $('txn-result').innerHTML = `<div class="msg ok">Done — status: <b>${esc(t.status)}</b>${t.reference ? ' · ref ' + esc(t.reference) : ''}</div>`;
      // Optionally save the DMT payee for next time.
      const save = $('ben_save');
      if (s.key === 'dmt' && save && save.checked && body.account_number) {
        Api.post('/beneficiaries', { name: body.beneficiary_name, account_number: body.account_number, ifsc: body.ifsc }).catch(() => {});
      }
      App.refreshWallet();
    } catch (err) {
      if (err.code === 'txn_mpin_required' || err.code === 'unauthorized' && /MPIN/i.test(err.message)) {
        const pin = prompt('Enter your transaction MPIN to confirm:');
        if (pin) return Actions.submitTxn(pin.trim());
        $('txn-result').innerHTML = '<div class="msg err">Transaction cancelled — MPIN required.</div>';
        return;
      }
      if (err.code === 'txn_mpin_not_set') {
        $('txn-result').innerHTML = `<div class="msg err">${esc(err.message)} — <a href="#/security">Set MPIN</a></div>`;
        return;
      }
      $('txn-result').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
    }
  },
  async topup() {
    const amt = prompt('Top-up amount (₹):', '500'); if (!amt) return;
    try {
      const o = await Api.post('/payment-gateway/orders', { amount: +amt });
      const orderId = o.order.gateway_order_id;
      const paymentId = 'pay_test_' + Math.random().toString(36).slice(2, 10);
      const signature = await sha256hex(orderId + '|' + paymentId); // sandbox gateway signature
      await Api.post(`/payment-gateway/orders/${o.order.id}/confirm`, { gateway_payment_id: paymentId, signature });
      UI.toast('Wallet topped up'); App.refreshWallet(); App.route();
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async receipt(id) {
    try {
      const res = await Api.raw(`/transactions/${id}/receipt`);
      const html = await res.text();
      const w = window.open('', '_blank');
      w.document.write(html); w.document.close();
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  // Open an authed HTML document (statement / passbook) in a new window.
  async openDoc(path) {
    try { const res = await Api.raw(path); const html = await res.text(); const w = window.open('', '_blank'); w.document.write(html); w.document.close(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // Download an authed CSV as a file.
  async dl(path, filename) {
    try {
      const res = await Api.raw(path);
      if (!res.ok) throw new Error('Download failed (' + res.status + ')');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  _range(pfx) { const f = val(pfx + '_from'), t = val(pfx + '_to'); const qs = []; if (f) qs.push('from=' + f); if (t) qs.push('to=' + t); return qs.join('&'); },
  addMember(asAdmin) {
    const roleOpts = (asAdmin ? MEMBER_ROLES : MEMBER_ROLES.filter(r => rank(r) < rank(State.user.role)))
      .map(r => `<option value="${r}">${r.replace(/_/g,' ')}</option>`).join('');
    UI.modal(`<h3>${asAdmin ? 'Create member' : 'Add downline member'}</h3>
      <div class="field"><label>Full name</label><input id="m_name"></div>
      <div class="field"><label>Username (optional)</label><input id="m_user"></div>
      <div class="field"><label>Email</label><input id="m_email" type="email"></div>
      <div class="field"><label>Mobile</label><input id="m_phone"></div>
      <div class="field"><label>Password</label><input id="m_pass" type="password"></div>
      <div class="field"><label>Role</label><select id="m_role">${roleOpts}</select></div>
      <div class="foot"><button class="btn" onclick="Actions.saveMember(${asAdmin})">Create</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveMember(asAdmin) {
    const body = { full_name: val('m_name'), email: val('m_email'), phone: val('m_phone'),
      password: val('m_pass'), role: val('m_role') };
    if (val('m_user')) body.username = val('m_user');
    try {
      await Api.post(asAdmin ? '/admin/users' : '/network/members', body);
      UI.closeModal(); UI.toast('Member created'); App.route();
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async setStatus(id, status) {
    try { await Api.patch(`/admin/users/${id}/status`, { status }); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async assessOnb(id) {
    try { const d = await Api.post(`/admin/onboarding/${id}/assess`, {});
      const a = d.assessment; UI.toast(`Risk ${a.total_score}/100 → ${a.decision}`); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async promote(id) {
    const tier = prompt('Set tier (probation / full):', 'full'); if (!tier) return;
    try { await Api.patch(`/admin/users/${id}/tier`, { tier }); UI.toast('Tier updated'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async pushFloat(id, name) {
    const amt = prompt(`Push float to ${name} (₹):`, '1000');
    if (!amt) return;
    try { await Api.post('/network/float', { to_user_id: id, amount: +amt }); UI.toast('Float pushed'); App.refreshWallet(); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async sweep(from, max) {
    const amt = prompt(`Sweep ${from} balance to main wallet (₹, max ${max}):`, String(max));
    if (!amt) return;
    try { await Api.post('/wallet/sweep', { from, amount: +amt }); UI.toast('Swept to main'); App.refreshWallet(); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async saveTaxProfile() {
    const body = {};
    if (val('tx_pan')) body.pan = val('tx_pan').toUpperCase();
    if (val('tx_name')) body.pan_name = val('tx_name');
    if (val('tx_gst')) body.gstin = val('tx_gst').toUpperCase();
    if (val('tx_state')) body.state_code = val('tx_state');
    try { await Api.put('/tax/profile', body); UI.toast('Saved — admin will verify your PAN'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  editIntegration(key, label, provider, baseUrl, senderId, isActive) {
    UI.modal(`<h3>Configure — ${esc(label)}</h3>
      <div class="field"><label>Provider</label><input id="ig_prov" value="${esc(provider)}" placeholder="MSG91 / SMTP / Protean"></div>
      <div class="field"><label>Base URL</label><input id="ig_url" value="${esc(baseUrl)}"></div>
      <div class="field"><label>API key</label><input id="ig_key" placeholder="(leave blank to keep)"></div>
      <div class="field"><label>API secret</label><input id="ig_secret" placeholder="(leave blank to keep)"></div>
      <div class="field"><label>Sender ID / From</label><input id="ig_sender" value="${esc(senderId)}"></div>
      <div class="field"><label><input type="checkbox" id="ig_active" ${isActive ? 'checked' : ''}> Active</label></div>
      <div class="foot"><button class="btn" onclick="Actions.saveIntegration('${key}')">Save</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async runRecon() {
    let rows;
    try { rows = JSON.parse(val('rc_rows')); } catch { return UI.toast('MIS rows must be valid JSON', 'err'); }
    try { const d = await Api.post('/admin/recon/run', { label: val('rc_label'), rows });
      UI.toast(`Recon: ${d.summary.matched} matched, ${d.summary.forceSettled} force-settled, ${d.summary.exceptions} exceptions`); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async listStale() {
    const min = Math.max(0, parseInt(val('sweep_min')) || 120);
    try {
      const d = await Api.get('/admin/recon/pending?older_than_min=' + min);
      const out = $('stale_out'); if (!out) return;
      if (!d.count) { out.innerHTML = `<span class="muted">No pending transactions older than ${min} min.</span>`; return; }
      out.innerHTML = `<b>${d.count}</b> stale pending (older than ${min} min):
        <div class="tbl-wrap mt"><table><thead><tr><th>Ref</th><th>Service</th><th class="right">Amount</th><th class="right">Age (min)</th></tr></thead>
        <tbody>${d.items.slice(0,50).map(t=>`<tr><td class="mono">${esc(t.reference)}</td><td>${esc(t.service)}</td>
          <td class="right">${money((t.amount_paise||0)/100)}</td><td class="right">${t.age_minutes}</td></tr>`).join('')}</tbody></table></div>`;
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async sweepStale() {
    const min = Math.max(60, parseInt(val('sweep_min')) || 120);
    if (min < 60) return UI.toast('Window must be at least 60 minutes', 'err');
    if (!confirm(`Fail & refund all pending transactions older than ${min} minutes? This reverses each debit to the member.`)) return;
    try {
      const d = await Api.post('/admin/recon/sweep', { older_than_min: min, remark: 'Manual stale-pending sweep' });
      UI.toast(`Swept ${d.swept} pending → failed${d.failed?`, ${d.failed} errors`:''}`);
      Actions.listStale();
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async createBatch() {
    let records;
    try { records = JSON.parse(val('bp_rows')); } catch { return UI.toast('Records must be valid JSON', 'err'); }
    if (!records.length) return UI.toast('Add at least one record', 'err');
    try { const d = await Api.post('/admin/payout-batches', { label: val('bp_label'), records });
      UI.toast(`Batch created: ${d.summary.record_count} records, ${money(d.summary.total_paise/100)} held`); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async reverseFeed(batchId) {
    const raw = prompt('Reverse feed rows JSON [{"record_id":"...","status":"settled|returned","utr":"..."}]:', '[]');
    if (!raw) return;
    let rows; try { rows = JSON.parse(raw); } catch { return UI.toast('Invalid JSON', 'err'); }
    try { const d = await Api.post(`/admin/payout-batches/${batchId}/reverse-feed`, { rows });
      UI.toast(`Settled ${d.result.settled}, returned ${d.result.returned}`); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async treasurySweep() {
    try { const d = await Api.post('/admin/treasury/sweep', { from_account: val('tr_from'), to_account: val('tr_to'), amount: +val('tr_amt') });
      UI.toast(`Swept ${money(d.sweep.amount_paise/100)}`); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async proposeAdj() {
    const uid = prompt('Target user ID:'); if (!uid) return;
    const kind = prompt('Kind (credit / debit / clawback):', 'credit'); if (!kind) return;
    const amount = prompt('Amount (₹):', '100'); if (!amount) return;
    const reason = prompt('Reason:', 'adjustment'); if (!reason) return;
    try { await Api.post('/admin/adjustments', { target_user_id: uid, kind, amount: +amount, reason }); UI.toast('Proposed — needs a second officer to approve'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async decideAdj(id, decision) {
    const note = prompt(`${decision === 'approve' ? 'Approve' : 'Reject'} this adjustment — enter a remark (required):`, '');
    if (note === null) return;
    if (!note.trim()) return UI.toast('A remark is required', 'err');
    try { await Api.post(`/admin/adjustments/${id}/${decision}`, { note: note.trim() }); UI.toast(`Adjustment ${decision}d`); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  presetSvc(key) { Actions._preset = key; },
  async saveProfile() {
    const body = {};
    if (val('pf_name')) body.full_name = val('pf_name');
    if (val('pf_email')) body.email = val('pf_email');
    if (val('pf_phone')) body.phone = val('pf_phone');
    try {
      const d = await Api.patch('/auth/me', body);
      // Refresh cached user + the header name.
      State.user = { ...State.user, ...d.user };
      $('who-name').textContent = State.user.full_name;
      UI.toast('Profile updated'); App.route();
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async changePassword() {
    const body = { current_password: val('cp_cur'), new_password: val('cp_new') };
    if (body.new_password.length < 8) return UI.toast('New password must be at least 8 characters', 'err');
    try { await Api.post('/security/password', body); UI.toast('Password changed — please log in again'); Auth.logout(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async setMpin() {
    const body = { current_password: val('mp_pw'), mpin: val('mp_pin') };
    if (!/^\d{4,6}$/.test(body.mpin)) return UI.toast('MPIN must be 4-6 digits', 'err');
    try { await Api.post('/security/mpin', body); UI.toast('MPIN set — required at next login'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async removeMpin() {
    const pw = prompt('Enter your current password to remove the MPIN:');
    if (!pw) return;
    try { await Api.call('/security/mpin', { method: 'DELETE', body: { current_password: pw } }); UI.toast('MPIN removed'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // ----- authenticator 2FA -----
  async start2fa() {
    try {
      const r = await Api.post('/security/2fa/setup', {});
      const box = $('tf_setup');
      box.innerHTML = `
        <p class="muted">1. Add this key to your authenticator app (Google Authenticator, Authy, 1Password…):</p>
        <div class="field"><label>Secret key (manual entry)</label>
          <input value="${esc(r.secret)}" readonly onclick="this.select()" style="font-family:monospace;letter-spacing:1px"></div>
        <p class="muted" style="word-break:break-all">Or open this link on the phone: <a href="${esc(r.otpauth_uri)}">${esc(r.otpauth_uri)}</a></p>
        <p class="muted">2. Enter the current 6-digit code to turn it on:</p>
        <div class="field"><label>Authenticator code</label><input id="tf_code" inputmode="numeric" maxlength="6" placeholder="000000"></div>
        <button class="btn" onclick="Actions.enable2fa()">Verify &amp; enable</button>`;
      $('tf_code').focus();
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async enable2fa() {
    const token = val('tf_code');
    if (!/^\d{6}$/.test(token)) return UI.toast('Enter the 6-digit code', 'err');
    try { await Api.post('/security/2fa/enable', { token }); UI.toast('Two-factor authentication enabled'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async disable2fa() {
    const current_password = val('tf_pw');
    if (!current_password) return UI.toast('Enter your current password', 'err');
    try { await Api.call('/security/2fa', { method: 'DELETE', body: { current_password } }); UI.toast('Two-factor authentication disabled'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // ----- active sessions -----
  async revokeSession(id) {
    if (!confirm('Revoke this session? That device will be signed out.')) return;
    try { await Api.del('/security/sessions/' + id); UI.toast('Session revoked'); Screens._loadSessions(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async revokeAllSessions() {
    if (!confirm('Log out of ALL sessions, including this one? You will need to sign in again.')) return;
    try { await Api.post('/security/sessions/revoke-all', {}); UI.toast('Logged out everywhere'); Auth.logout(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // ----- beneficiaries -----
  addBeneficiary() {
    UI.modal(`<h3>Add beneficiary</h3>
      <div class="field"><label>Name</label><input id="bn_name"></div>
      <div class="field"><label>Account number</label><input id="bn_acc"></div>
      <div class="field"><label>IFSC</label><input id="bn_ifsc" placeholder="HDFC0001234"></div>
      <div class="field"><label>Bank name (optional)</label><input id="bn_bank"></div>
      <div class="foot"><button class="btn" onclick="Actions.saveBeneficiary()">Save</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveBeneficiary() {
    const body = { name: val('bn_name'), account_number: val('bn_acc'), ifsc: val('bn_ifsc').toUpperCase() };
    if (val('bn_bank')) body.bank_name = val('bn_bank');
    try { await Api.post('/beneficiaries', body); UI.closeModal(); UI.toast('Beneficiary saved'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async delBeneficiary(id) {
    if (!confirm('Delete this beneficiary?')) return;
    try { await Api.del('/beneficiaries/' + id); UI.toast('Deleted'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // ----- device binding -----
  bindDevice() {
    UI.modal(`<h3>Bind a device</h3>
      <div class="field"><label>Device label</label><input id="dv_label" placeholder="Mantra MFS110"></div>
      <div class="field"><label>Device ID / UUID</label><input id="dv_uuid" placeholder="serial or UUID"></div>
      <div class="field"><label>IMEI (optional)</label><input id="dv_imei"></div>
      <div class="foot"><button class="btn" onclick="Actions.saveDevice()">Bind</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveDevice() {
    const body = { device_uuid: val('dv_uuid') };
    if (val('dv_label')) body.label = val('dv_label');
    if (val('dv_imei')) body.imei = val('dv_imei');
    if (!body.device_uuid) return UI.toast('Enter a device ID', 'err');
    try { await Api.post('/onboarding/device', body); UI.closeModal(); UI.toast('Device bound'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // Withdrawals: mark paid (with UTR) / reject (refunds wallet).
  async payWithdrawal(id) {
    const utr = prompt('Enter the bank UTR / reference for this payout:', '');
    if (utr === null) return;
    const remarks = prompt('Remark (optional):', 'Paid via NEFT') ?? undefined;
    try { await Api.post(`/admin/withdrawals/${id}/approve`, { utr: utr.trim() || undefined, remarks });
      UI.toast('Marked paid'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async rejectWithdrawal2(id) {
    const remarks = prompt('Reject this withdrawal — reason (required):', '');
    if (remarks === null) return;
    if (!remarks.trim()) return UI.toast('A reason is required', 'err');
    try { await Api.post(`/admin/withdrawals/${id}/reject`, { remarks: remarks.trim() });
      UI.toast('Rejected & refunded'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // Wallet lien / blocked amount: view, place and release holds on a user.
  async holds(userId, name) {
    const d = await Api.get(`/admin/users/${userId}/holds`);
    const rows = (d.items || []).map(h => `<tr>
      <td class="right">${money(h.amount_paise/100)}</td>
      <td>${esc(h.reason||'')}</td>
      <td>${UI.statusTag(h.status)}</td>
      <td class="muted">${new Date(h.created_at).toLocaleDateString('en-IN')}</td>
      <td>${h.status==='active' ? `<button class="btn sm" onclick="Actions.releaseHold('${userId}','${h.id}','${esc(name)}')">Release</button>` : `<span class="muted">by ${esc(h.released_by_name||'')}</span>`}</td>
    </tr>`).join('');
    UI.modal(`<h3>Wallet holds — ${esc(name)}</h3>
      <p class="muted" style="font-size:13px">Currently blocked: <b>${money((d.held_paise||0)/100)}</b>. Held funds can't be spent until released.</p>
      <div class="row" style="gap:8px;align-items:end">
        <div class="field" style="margin:0"><label>Amount (₹)</label><input id="hold_amt" type="number" min="1" step="0.01" style="width:130px"></div>
        <div class="field" style="margin:0;flex:1"><label>Reason</label><input id="hold_reason" placeholder="dispute / pending settlement"></div>
        <button class="btn sm" onclick="Actions.placeHold('${userId}','${esc(name)}')">Place hold</button>
      </div>
      <div class="tbl-wrap mt"><table><thead><tr><th class="right">Amount</th><th>Reason</th><th>Status</th><th>When</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=5 class=muted>No holds yet.</td></tr>'}</tbody></table></div>
      <div class="foot"><button class="btn ghost" onclick="UI.closeModal()">Close</button></div>`);
  },
  async placeHold(userId, name) {
    const amt = +val('hold_amt'); if (!amt || amt <= 0) return UI.toast('Enter an amount', 'err');
    try { await Api.post(`/admin/users/${userId}/holds`, { amount: amt, reason: val('hold_reason') || undefined });
      UI.closeModal(); UI.toast('Hold placed'); Actions.holds(userId, name); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async releaseHold(userId, holdId, name) {
    try { await Api.post(`/admin/users/${userId}/holds/${holdId}/release`, {});
      UI.toast('Hold released'); Actions.holds(userId, name); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async resetUserPw(id, name) {
    const pw = prompt(`Set a new password for ${name} (min 8 chars):`);
    if (!pw) return;
    if (pw.length < 8) return UI.toast('Min 8 characters', 'err');
    try { await Api.post(`/admin/users/${id}/reset-password`, { new_password: pw }); UI.toast('Password reset'); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // ---- Staff & permissions ----
  _permBoxes(selected) {
    const cat = App._permCatalog || { permissions: [], presets: {} };
    const sel = new Set(selected || []);
    const groups = {};
    cat.permissions.forEach(p => { (groups[p.group] ??= []).push(p); });
    const body = Object.entries(groups).map(([g, ps]) => `
      <div style="margin-bottom:10px"><div class="muted" style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px">${esc(g)}</div>
      ${ps.map(p => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0;font-size:13px">
        <input type="checkbox" class="perm-box" value="${esc(p.key)}" ${sel.has(p.key)?'checked':''}> ${esc(p.label)}</label>`).join('')}</div>`).join('');
    const presets = Object.entries(cat.presets).map(([k, v]) =>
      `<button type="button" class="btn sm ghost" onclick="Actions.applyPreset('${k}')">${esc(v.label)}</button>`).join(' ');
    return `<div class="muted" style="font-size:12px;margin-bottom:6px">Quick presets: ${presets}</div>${body}`;
  },
  applyPreset(key) {
    const preset = (App._permCatalog.presets || {})[key];
    if (!preset) return;
    const set = new Set(preset.permissions);
    document.querySelectorAll('.perm-box').forEach(b => { b.checked = set.has(b.value); });
  },
  _collectPerms() { return [...document.querySelectorAll('.perm-box:checked')].map(b => b.value); },
  async addStaff(kind) {
    kind = kind || 'human';
    Actions._newStaffKind = kind;
    const ai = kind === 'ai';
    UI.modal(`<h3>Add ${ai ? 'AI agent' : 'staff member'}</h3>
      <div class="field"><label>${ai ? 'Agent name' : 'Full name'}</label><input id="st_name" placeholder="${ai?'Dispute Bot':''}"></div>
      <div class="field"><label>Email</label><input id="st_email" type="email"></div>
      <div class="field"><label>Mobile (10 digit)</label><input id="st_phone"></div>
      ${ai
        ? `<p class="muted" style="font-size:13px">An API key will be generated for this agent to authenticate (Bearer tpk_…). It's shown once.</p>`
        : `<div class="field"><label>Temporary password (min 8)</label><input id="st_pw" type="password"></div>`}
      <h4 style="margin:14px 0 6px">Powers</h4>
      <div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:12px">${Actions._permBoxes([])}</div>
      <div class="foot"><button class="btn" onclick="Actions.saveNewStaff()">${ai ? 'Create agent &amp; issue key' : 'Create staff'}</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveNewStaff() {
    const kind = Actions._newStaffKind || 'human';
    const body = { full_name: val('st_name'), email: val('st_email'), phone: val('st_phone'),
      kind, permissions: Actions._collectPerms() };
    if (kind !== 'ai') body.password = $('st_pw').value;
    try {
      const d = await Api.post('/staff', body); UI.closeModal();
      if (d.api_key) Actions.showApiKey(d.api_key, d.staff && d.staff.full_name);
      else UI.toast('Staff member added');
      App.route();
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  showApiKey(key, name) {
    UI.modal(`<h3>API key for ${esc(name||'AI agent')}</h3>
      <p class="muted">Copy this key now — it is shown only once. Use it as <code>Authorization: Bearer &lt;key&gt;</code> in n8n / your AI agent.</p>
      <div class="field"><input value="${esc(key)}" readonly onclick="this.select()" style="font-family:monospace"></div>
      <div class="foot"><button class="btn" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(key)}');UI.toast('Copied')">Copy</button>
        <button class="btn ghost" onclick="UI.closeModal()">Done</button></div>`);
  },
  async regenToken(id) {
    if (!confirm('Issue a new API key? The old key stops working immediately.')) return;
    try { const d = await Api.post(`/staff/${id}/token`, {}); Actions.showApiKey(d.api_key); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async revokeToken(id) {
    if (!confirm('Revoke this agent\'s API key? It will stop working immediately.')) return;
    try { await Api.post(`/staff/${id}/token/revoke`, {}); UI.toast('Key revoked'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async editStaff(s) {
    UI.modal(`<h3>Permissions — ${esc(s.full_name)}</h3>
      <p class="muted" style="font-size:13px">Tick the sections this staff member may use.</p>
      <div style="max-height:320px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:12px">${Actions._permBoxes(s.permissions || [])}</div>
      <div class="foot"><button class="btn" onclick="Actions.saveStaffPerms('${s.id}')">Save permissions</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveStaffPerms(id) {
    try { await Api.patch(`/staff/${id}`, { permissions: Actions._collectPerms() }); UI.closeModal(); UI.toast('Permissions updated'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async staffStatus(id, status) {
    try { await Api.post(`/staff/${id}/status`, { status }); UI.toast(`Staff ${status}`); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async saveTaxConfig(codes) {
    const items = codes.map(code => ({
      code,
      rate_percent: +val('tc_rate_' + code),
      max_amount: +val('tc_max_' + code),
      enabled: $('tc_en_' + code).checked,
    }));
    try { await Api.put('/admin/tax-config', { items }); UI.toast('Tax rates saved'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // Read a chosen image, downscale it and store it inline (data URL) in the
  // matching URL field. Keeps posters/logos self-contained — no file server.
  async uploadImage(key, input) {
    const file = input.files && input.files[0];
    const msg = $('upmsg_' + key);
    if (!file) return;
    if (!/^image\//.test(file.type)) { if (msg) msg.textContent = 'Please choose an image.'; return; }
    if (msg) msg.textContent = 'Processing…';
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result); fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      const img = await new Promise((resolve, reject) => {
        const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = dataUrl;
      });
      // Downscale to a sensible max width so the stored string stays small.
      const maxW = key === 'logo_url' ? 240 : 1200;
      const scale = Math.min(1, maxW / img.width);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const out = cv.toDataURL('image/jpeg', 0.82);
      if (out.length > 1500000) { if (msg) msg.textContent = 'Image too large after compression — pick a smaller one.'; return; }
      $('ws_' + key).value = out;
      if (msg) msg.innerHTML = `<span style="color:#137333">✔ Uploaded — click Save branding to apply.</span>`;
    } catch { if (msg) msg.textContent = 'Could not read that image.'; }
  },
  async saveSite() {
    const keys = ['brand_name','logo_emoji','logo_url','primary_color','tagline','support_email','admin_email','phone','company_name','company_address','auth_poster_url','auth_poster_title','auth_poster_subtitle','auth_poster_link','security_admin_ip_allowlist','duplicate_txn_window_minutes','aggregator_webhook_secret','automation_webhook_url','meta_description','meta_keywords','og_image_url','google_analytics_id','social_facebook','social_instagram','social_twitter','social_youtube','social_whatsapp','low_balance_threshold','dispute_sla_hours','auto_recon_hours'];
    const values = {}; keys.forEach(k => values[k] = val('ws_'+k));
    values['security_require_txn_mpin'] = $('ws_security_require_txn_mpin').checked ? 'true' : 'false';
    values['security_require_signup_otp'] = $('ws_security_require_signup_otp').checked ? 'true' : 'false';
    values['security_require_kyc'] = $('ws_security_require_kyc').checked ? 'true' : 'false';
    values['notify_txn_sms'] = $('ws_notify_txn_sms').checked ? 'true' : 'false';
    values['notify_low_balance'] = $('ws_notify_low_balance').checked ? 'true' : 'false';
    values['notify_kyc'] = $('ws_notify_kyc').checked ? 'true' : 'false';
    try { await Api.put('/admin/site/settings', { values }); UI.toast('Settings saved'); App.applyBranding(); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async editPage(slug) {
    let page = { slug: '', title: '', content: '', published: true, sort_order: 0 };
    if (slug) { const d = await Api.get('/admin/site/pages/' + slug); page = d.page; }
    UI.modal(`<h3>${slug ? 'Edit' : 'New'} page</h3>
      <div class="field"><label>Slug (URL)</label><input id="pg_slug" value="${esc(page.slug)}" ${slug?'readonly':''} placeholder="careers"></div>
      <div class="field"><label>Title</label><input id="pg_title" value="${esc(page.title)}"></div>
      <div class="field"><label>Content (HTML allowed)</label><textarea id="pg_content" rows="8" style="width:100%;font-family:monospace">${esc(page.content||'')}</textarea></div>
      <div class="field"><label><input type="checkbox" id="pg_pub" ${page.published?'checked':''}> Published</label></div>
      <div class="foot"><button class="btn" onclick="Actions.savePage()">Save</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async savePage() {
    const slug = val('pg_slug');
    const body = { slug, title: val('pg_title'), content: $('pg_content').value, published: $('pg_pub').checked, sort_order: 0 };
    try { await Api.put('/admin/site/pages/' + slug, body); UI.closeModal(); UI.toast('Page saved'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async deletePage(slug) {
    if (!confirm('Delete page "' + slug + '"?')) return;
    try { await Api.del('/admin/site/pages/' + slug); UI.toast('Deleted'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async saveIntegration(key) {
    const body = { is_active: $('ig_active').checked };
    if (val('ig_prov')) body.provider = val('ig_prov');
    if (val('ig_url')) body.base_url = val('ig_url');
    if (val('ig_key')) body.api_key = val('ig_key');
    if (val('ig_secret')) body.api_secret = val('ig_secret');
    if (val('ig_sender')) body.sender_id = val('ig_sender');
    try { await Api.put(`/admin/integrations/${key}`, body); UI.closeModal(); UI.toast('Integration saved'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async reviewKyc(id, status) {
    // Every approval / rejection must carry a remark for the audit trail.
    const remarks = prompt(`${status === 'verified' ? 'Approve' : 'Reject'} this document — enter a remark (required):`,
      status === 'verified' ? 'Documents verified' : '');
    if (remarks === null) return;
    if (!remarks.trim()) return UI.toast('A remark is required to approve or reject', 'err');
    try { await Api.post(`/kyc/${id}/review`, { status, remarks: remarks.trim() }); UI.toast('KYC ' + status); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async submitKyc() {
    const body = { doc_type: val('k_type') };
    if (val('k_num')) body.doc_number = val('k_num');
    if (val('k_url')) body.file_url = val('k_url');
    try { await Api.post('/kyc', body); UI.toast('Document submitted for review'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async verifyPanNow() {
    const pan = (val('vp_pan')||'').toUpperCase(), name = val('vp_name');
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return UI.toast('Enter a valid PAN', 'err');
    $('vp_out').textContent = 'Verifying…';
    try {
      const r = await Api.post('/kyc/verify/pan', { pan, name });
      $('vp_out').innerHTML = r.verified ? `<span style="color:#12a35a">✅ ${esc(r.message)}${r.sandbox?' (sandbox)':''}</span>` : `<span style="color:#c5342b">✕ ${esc(r.message)}</span>`;
      if (r.verified) { UI.toast('PAN verified'); setTimeout(() => App.route(), 900); }
    } catch (err) { $('vp_out').textContent = ''; UI.toast(err.message, 'err'); }
  },
  async aadhaarSendOtpNow() {
    const aadhaar = val('va_num');
    if (!/^\d{12}$/.test(aadhaar)) return UI.toast('Enter a 12-digit Aadhaar', 'err');
    try {
      const r = await Api.post('/kyc/verify/aadhaar/send-otp', { aadhaar });
      Actions._aadhaarRef = r.ref; $('va_otpbox').classList.remove('hidden');
      $('va_out').textContent = r.message + (r.sandbox ? '' : '');
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async aadhaarVerifyOtpNow() {
    const aadhaar = val('va_num'), otp = val('va_otp');
    try {
      const r = await Api.post('/kyc/verify/aadhaar/verify-otp', { aadhaar, ref: Actions._aadhaarRef || '', otp });
      $('va_out').innerHTML = r.verified ? `<span style="color:#12a35a">✅ ${esc(r.message)}</span>` : `<span style="color:#c5342b">✕ ${esc(r.message)}</span>`;
      if (r.verified) { UI.toast('Aadhaar verified'); setTimeout(() => App.route(), 900); }
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async toggleService(code, enabled) {
    try { await Api.patch(`/admin/services/${code}`, { enabled }); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  setServiceLimits(code, minPaise, maxRupees) {
    UI.modal(`<h3>Commission limits — ${esc(code)}</h3>
      <p class="muted">Total commission distributed per transaction must fall between these bounds (in ₹). Leave max blank for no ceiling.</p>
      <div class="field"><label>Minimum commission (₹)</label><input id="lim_min" type="number" step="0.01" min="0" value="${(minPaise||0)/100}"></div>
      <div class="field"><label>Maximum commission (₹)</label><input id="lim_max" type="number" step="0.01" min="0" value="${maxRupees}"></div>
      <div class="foot"><button class="btn" onclick="Actions.saveServiceLimits('${code}')">Save</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveServiceLimits(code) {
    const body = { min_commission: +val('lim_min') };
    if (val('lim_max') !== '') body.max_commission = +val('lim_max');
    try { await Api.patch(`/admin/services/${code}`, body); UI.closeModal(); UI.toast('Limits saved'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },

  // ----- wallet top-up (member) -----
  async submitTopup() {
    const body = { amount: +val('tu_amt'), method: val('tu_method'), reference: val('tu_ref') };
    if (val('tu_bank')) body.bank_account_id = val('tu_bank');
    if (val('tu_proof')) body.proof_url = val('tu_proof');
    if (!body.amount) return UI.toast('Enter an amount', 'err');
    try { await Api.post('/topup', body); UI.toast('Top-up request submitted for approval'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async approveTopup(id) {
    const remarks = prompt('Approve this top-up — enter a remark (required):', 'Payment verified');
    if (remarks === null) return;
    if (!remarks.trim()) return UI.toast('A remark is required', 'err');
    try { await Api.post(`/admin/topups/${id}/approve`, { remarks: remarks.trim() }); UI.toast('Approved & wallet credited'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async rejectTopup(id) {
    const remarks = prompt('Reject this top-up — enter a reason (required):', '');
    if (remarks === null) return;
    if (!remarks.trim()) return UI.toast('A reason is required to reject', 'err');
    try { await Api.post(`/admin/topups/${id}/reject`, { remarks: remarks.trim() }); UI.toast('Rejected'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },

  // ----- company bank accounts (admin) -----
  addBank() {
    UI.modal(`<h3>Add company bank account</h3>
      <div class="field"><label>Label</label><input id="b_label" placeholder="HDFC Current — Mumbai"></div>
      <div class="field"><label>Bank name</label><input id="b_bank"></div>
      <div class="field"><label>Account name</label><input id="b_name" value="REAL BROTHERS TECHNOLOGY SERVICES LLP"></div>
      <div class="field"><label>Account number</label><input id="b_acc"></div>
      <div class="field"><label>IFSC</label><input id="b_ifsc"></div>
      <div class="field"><label>Branch (optional)</label><input id="b_branch"></div>
      <div class="field"><label>UPI ID (optional)</label><input id="b_upi"></div>
      <div class="field"><label>Instructions (optional)</label><input id="b_instr" placeholder="Deposit and share UTR"></div>
      <div class="foot"><button class="btn" onclick="Actions.saveBank()">Add</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveBank() {
    const body = { label: val('b_label'), bank_name: val('b_bank'), account_name: val('b_name'),
      account_number: val('b_acc'), ifsc: val('b_ifsc').toUpperCase() };
    if (val('b_branch')) body.branch = val('b_branch');
    if (val('b_upi')) body.upi_id = val('b_upi');
    if (val('b_instr')) body.instructions = val('b_instr');
    try { await Api.post('/admin/bank-accounts', body); UI.closeModal(); UI.toast('Account added'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async toggleBank(id, is_active) {
    try { await Api.patch(`/admin/bank-accounts/${id}`, { is_active }); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async deleteBank(id) {
    if (!confirm('Delete this bank account?')) return;
    try { await Api.del(`/admin/bank-accounts/${id}`); UI.toast('Deleted'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },

  // ----- service providers (admin) -----
  // ----- AI Dev Desk -----
  newDev() {
    UI.modal(`<h3>New request</h3>
      <div class="field"><label>Type</label><select id="dv_kind">
        <option value="feature">✨ Feature</option><option value="bug">🐞 Bug</option><option value="ui">🎨 UI / design</option></select></div>
      <div class="field"><label>Title</label><input id="dv_title" placeholder="Short summary of what you want"></div>
      <div class="field"><label>Area (optional)</label><input id="dv_area" placeholder="e.g. payout, retailer dashboard"></div>
      <div class="field"><label>Priority</label><select id="dv_prio"><option>low</option><option selected>normal</option><option>high</option><option>urgent</option></select></div>
      <div class="field"><label>Details</label><textarea id="dv_desc" rows="5" placeholder="Describe the feature or the bug (steps to reproduce, what you expected)…"></textarea></div>
      <div class="foot"><button class="btn" onclick="Actions.saveDev()">File request</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveDev() {
    const body = { kind: val('dv_kind'), title: val('dv_title'), area: val('dv_area'), priority: val('dv_prio'), description: val('dv_desc') };
    if (!body.title || body.title.length < 3) return UI.toast('Enter a title', 'err');
    try { const r = await Api.post('/admin/devdesk', body); UI.closeModal(); UI.toast('Filed'); Actions.viewDev(r.request.id); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  _planBox(plan) {
    if (!plan) return `<div class="muted" style="padding:8px 0">No plan yet. Click <b>AI: draft plan</b> to generate what to build/fix.</div>`;
    const list = (t, arr, ic) => (arr && arr.length) ? `<div style="margin-top:8px"><b>${ic} ${t}</b><ul style="margin:4px 0">${arr.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
    return `<div class="panel" style="background:#f7f8fb;margin-top:10px">
      <div style="font-size:13px"><b>Summary:</b> ${esc(plan.summary||'')}
        ${plan.effort?`&nbsp;<span class="tag active">${esc(plan.effort)}</span>`:''}
        ${plan._source?`<span class="muted" style="font-size:11px">· ${plan._source==='ai'?('AI '+(plan._model||'')):'template'}</span>`:''}</div>
      ${list('What to build / fix', plan.changes, '🔧')}
      ${list('Areas / files', plan.areas, '📂')}
      ${list('Risks', plan.risks, '⚠️')}
      ${list('How to test', plan.tests, '✅')}</div>`;
  },
  async viewDev(id) {
    const d = await Api.get('/admin/devdesk').catch(() => ({ items: [] }));
    const r = (d.items || []).find(x => x.id === id);
    if (!r) return UI.toast('Not found', 'err');
    const done = ['approved','dispatched','done','rejected'].includes(r.status);
    UI.modal(`<h3>${esc(r.ticket_no||'')} — ${esc(r.title)}</h3>
      <div class="muted" style="font-size:12px">${esc(r.kind)} · ${esc(r.priority)} · ${UI.statusTag(r.status)} ${r.area?'· '+esc(r.area):''}</div>
      <div style="white-space:pre-wrap;margin-top:8px;font-size:13px">${esc(r.description||'')}</div>
      ${this._planBox(r.ai_plan)}
      ${r.remark?`<div class="muted" style="margin-top:8px;font-size:12px">Remark: ${esc(r.remark)}</div>`:''}
      <div class="foot" style="flex-wrap:wrap;gap:6px">
        <button class="btn sm" onclick="Actions.triageDev('${r.id}')">🤖 AI: draft plan</button>
        ${!done?`<button class="btn sm" onclick="Actions.approveDev('${r.id}')">✅ Approve &amp; dispatch</button>
        <button class="btn sm ghost" onclick="Actions.rejectDev('${r.id}')">Reject</button>`:''}
        ${r.status==='approved'?`<button class="btn sm ghost" onclick="Actions.devStatus('${r.id}','dispatched')">Mark dispatched</button>`:''}
        ${(r.status==='approved'||r.status==='dispatched')?`<button class="btn sm ghost" onclick="Actions.devStatus('${r.id}','done')">Mark done</button>`:''}
        <button class="btn sm ghost" onclick="UI.closeModal()">Close</button></div>`);
  },
  async triageDev(id) {
    UI.toast('Drafting plan…');
    try { const r = await Api.post(`/admin/devdesk/${id}/triage`, {}); UI.toast(r.source==='ai'?'AI plan ready':'Template plan (configure AI)'); Actions.viewDev(id); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async approveDev(id) {
    const remark = prompt('Approval note (what to build/fix, any constraints):', 'Approved — proceed'); if (remark === null) return;
    try { await Api.post(`/admin/devdesk/${id}/approve`, { remark }); UI.closeModal(); UI.toast('Approved & dispatched to automation'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async rejectDev(id) {
    const remark = prompt('Reason for rejection:'); if (remark === null) return;
    try { await Api.post(`/admin/devdesk/${id}/reject`, { remark }); UI.closeModal(); UI.toast('Rejected'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async devStatus(id, status) {
    try { await Api.post(`/admin/devdesk/${id}/status`, { status }); UI.closeModal(); UI.toast('Updated'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },

  // ----- AI Integration Studio -----
  async aiSaveModel() {
    const mode = val('ai_mode'), url = val('ai_url'), key = val('ai_key'), model = val('ai_model') || 'gpt-4o-mini';
    if (!url) return UI.toast('Enter the endpoint / n8n URL', 'err');
    const body = { category: 'other', label: 'AI coder', base_url: url, provider: mode === 'n8n' ? 'n8n' : model,
      extra: { mode, model }, is_active: true };
    if (key) body.api_key = key;
    try { await Api.put('/admin/integrations/ai_coder', body); UI.toast('AI settings saved'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async aiDraft() {
    const services = [...document.querySelectorAll('.ai_svc:checked')].map(x => x.value);
    if (!services.length) return UI.toast('Pick at least one service', 'err');
    const docs = val('ai_docs');
    UI.toast('Generating…');
    try {
      const d = await Api.post('/admin/integrations/ai-draft', { docs, services });
      Actions._aiCfg = d.config;
      const src = d.source === 'ai' ? `✨ Generated by AI (${esc(d.model||'model')})` : '📝 Fillable template (configure AI above for auto-generation)';
      $('ai_out').innerHTML = `
        <div class="msg" style="margin-top:12px">${src}. Review &amp; edit the config, test the mapping, then save.</div>
        <div class="field"><label>Provider label</label><input id="ai_plabel" placeholder="e.g. MyAggregator" style="max-width:320px"></div>
        <div class="row">
          <div class="field"><label>API key (client-id / developer_key)</label><input id="ai_ckey"></div>
          <div class="field"><label>API secret</label><input id="ai_csecret"></div>
          <div class="field"><label>Auth token</label><input id="ai_ctoken"></div>
          <div class="field"><label>Partner ID</label><input id="ai_cpartner"></div>
        </div>
        <div class="field"><label>Config (JSON) — the whole integration, editable</label>
          <textarea id="ai_json" rows="16" style="width:100%;font-family:ui-monospace,monospace;font-size:12px">${esc(JSON.stringify(d.config, null, 2))}</textarea></div>
        <div class="row" style="gap:8px">
          <select id="ai_testsvc" style="max-width:160px">${services.map(s=>`<option>${esc(s)}</option>`).join('')}</select>
          <button class="btn sm ghost" onclick="Actions.aiTest()">🧪 Test mapping</button>
          <button class="btn sm ghost" onclick="Actions.aiLiveTest()">🔴 Live call</button>
          <button class="btn" onclick="Actions.aiSaveProvider()">💾 Save &amp; activate provider</button>
        </div>
        <p class="muted" style="font-size:11.5px;margin:6px 0 0">🔴 <b>Live call</b> sends a real request to the provider with test data — use sandbox / UAT credentials.</p>
        <div id="ai_test"></div>`;
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  _parseAiJson() { try { return JSON.parse(val('ai_json')); } catch { UI.toast('Config is not valid JSON', 'err'); return null; } },
  async aiTest() {
    const config = this._parseAiJson(); if (!config) return;
    const body = { service: val('ai_testsvc'), config, creds: {
      base_url: '', api_key: val('ai_ckey'), api_secret: val('ai_csecret'), auth_token: val('ai_ctoken'), partner_id: val('ai_cpartner') } };
    try {
      const r = await Api.post('/admin/integrations/provider-test', body);
      $('ai_test').innerHTML = `<div class="panel mt" style="background:${r.ok?'#f0fbf4':'#fef7e0'}">
        <b>${r.ok?'✅ Mapping resolves':'⚠️ Fix these first'}</b>
        ${(r.problems||[]).length?`<ul>${r.problems.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`:''}
        ${r.url?`<div class="mono" style="font-size:12px;margin-top:8px"><b>${esc(r.method)}</b> ${esc(r.url)}</div>
        <div class="muted" style="font-size:12px;margin-top:6px">Headers: <span class="mono">${esc(JSON.stringify(r.headers))}</span></div>
        <pre style="background:#111;color:#eee;border-radius:8px;padding:10px;overflow:auto;font-size:12px;margin-top:8px">${esc(JSON.stringify(r.body, null, 2))}</pre>`:''}</div>`;
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async aiLiveTest() {
    const config = this._parseAiJson(); if (!config) return;
    const body = { service: val('ai_testsvc'), live: true, config, creds: {
      base_url: '', api_key: val('ai_ckey'), api_secret: val('ai_csecret'), auth_token: val('ai_ctoken'), partner_id: val('ai_cpartner') } };
    UI.toast('Calling provider…');
    try {
      const r = await Api.post('/admin/integrations/provider-test', body);
      if (!r.live) { // mapping failed validation — show the same problems view
        $('ai_test').innerHTML = `<div class="panel mt" style="background:#fef7e0"><b>⚠️ Fix the mapping first</b>
          <ul>${(r.problems||[]).map(p=>`<li>${esc(p)}</li>`).join('')}</ul></div>`;
        return;
      }
      const st = r.result?.status || 'pending';
      $('ai_test').innerHTML = `<div class="panel mt" style="background:${st==='success'?'#f0fbf4':st==='failed'?'#fdecea':'#fef7e0'}">
        <b>🔴 Live provider response</b> &nbsp; ${UI.statusTag(st)}
        <div class="mono" style="font-size:12px;margin-top:8px">${esc(r.request?.method||'POST')} ${esc(r.request?.url||'')}</div>
        <div style="font-size:12.5px;margin-top:8px">
          ${r.result?.providerRef?`Provider ref: <b class="mono">${esc(r.result.providerRef)}</b><br>`:''}
          ${r.result?.utr?`UTR: <b class="mono">${esc(r.result.utr)}</b><br>`:''}
          ${r.result?.message?`Message: ${esc(r.result.message)}`:''}
        </div>
        <pre style="background:#111;color:#eee;border-radius:8px;padding:10px;overflow:auto;font-size:12px;margin-top:8px">${esc(JSON.stringify(r.result?.raw ?? {}, null, 2))}</pre></div>`;
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async aiSaveProvider() {
    const config = this._parseAiJson(); if (!config) return;
    const label = val('ai_plabel'); if (!label) return UI.toast('Enter a provider label', 'err');
    const services = Object.keys(config.services || {});
    if (!services.length) return UI.toast('Config has no services', 'err');
    const creds = { api_key: val('ai_ckey'), api_secret: val('ai_csecret'), auth_token: val('ai_ctoken'), partner_id: val('ai_cpartner') };
    let made = 0;
    for (const code of services) {
      const body = { label: `${label} (${code})`, driver: 'dynamic', is_active: true, extra: config };
      if (config.base_url) body.base_url = config.base_url;
      for (const [k,v] of Object.entries(creds)) if (v) body[k] = v;
      try { await Api.post(`/admin/services/${code}/providers`, body); made++; }
      catch (err) { UI.toast(`${code}: ${err.message}`, 'err'); }
    }
    if (made) { UI.toast(`Saved & activated for ${made} service(s)`); location.hash = '#/providers'; }
  },

  _provService: null,
  async addProvider(code) {
    // Load the known-provider directory for a quick-pick that pre-fills the form.
    const dir = await Api.get('/admin/provider-directory').catch(() => ({ items: [] }));
    Actions._provDir = dir.items || [];
    const dirOpts = ['<option value="">— pick a known provider (optional) —</option>']
      .concat(Actions._provDir.map((p, i) => `<option value="${i}">${esc(p.name)} · ${esc(p.services || '')}</option>`)).join('');
    UI.modal(`<h3>Add provider — ${esc(code)}</h3>
      <div class="field"><label>Known provider</label>
        <select id="p_known" onchange="Actions.pickKnownProvider()">${dirOpts}</select></div>
      <p class="muted" id="p_known_note" style="font-size:12px;margin:2px 0 8px"></p>
      <div class="field"><label>Label</label><input id="p_label" placeholder="Paysprint / RazorpayX"></div>
      <div class="field"><label>Driver</label><select id="p_driver" onchange="Actions.providerDriverHint()">
        <option value="dynamic">dynamic (config-driven — build in AI Integration Studio)</option>
        <option value="sandbox">sandbox (test)</option><option value="aggregator">aggregator (generic DMT/BBPS/recharge switch)</option>
        <option value="aeronpay">AeronPay (payout, recharge, BBPS, DMT)</option>
        <option value="eko">Eko (DMT, AEPS, BBPS, recharge)</option>
        <option value="razorpay">razorpay (payout/gateway)</option><option value="generic">generic</option></select></div>
      <p class="muted" id="p_hint" style="font-size:12px;margin:2px 0 0"></p>
      <div class="field"><label>Base URL <span class="muted">(blank = provider default)</span></label><input id="p_url" placeholder="https://api.provider.com"></div>
      <div class="field"><label id="p_key_l">API key</label><input id="p_key"></div>
      <div class="field"><label id="p_secret_l">API secret</label><input id="p_secret"></div>
      <div class="field"><label>Auth token</label><input id="p_token"></div>
      <div class="field"><label id="p_partner_l">Partner ID</label><input id="p_partner"></div>
      <div class="field"><label>Advanced config (JSON) <span class="muted">— e.g. Eko {"user_code":"..."} or path overrides</span></label>
        <input id="p_extra" placeholder='{"user_code":"20810200","payout_path":"/payout/transfer"}'></div>
      <div class="field"><label>Callback secret (HMAC key for this provider's webhook)</label><input id="p_wsecret" placeholder="leave blank to use the global aggregator secret"></div>
      <div class="field"><label><input type="checkbox" id="p_active" checked> Make active (route through this)</label></div>
      <div class="foot"><button class="btn" onclick="Actions.saveProvider('${code}')">Add</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveProvider(code) {
    const body = { label: val('p_label'), driver: val('p_driver'), is_active: $('p_active').checked };
    if (val('p_url')) body.base_url = val('p_url');
    if (val('p_key')) body.api_key = val('p_key');
    if (val('p_secret')) body.api_secret = val('p_secret');
    if (val('p_token')) body.auth_token = val('p_token');
    if (val('p_partner')) body.partner_id = val('p_partner');
    if (val('p_wsecret')) body.webhook_secret = val('p_wsecret');
    const ex = val('p_extra');
    if (ex) { try { body.extra = JSON.parse(ex); } catch { return UI.toast('Advanced config must be valid JSON', 'err'); } }
    try { await Api.post(`/admin/services/${code}/providers`, body); UI.closeModal(); UI.toast('Provider added'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // Quick-pick from the known-provider directory: pre-fill label + driver + note.
  pickKnownProvider() {
    const i = val('p_known');
    const note = $('p_known_note');
    if (i === '') { if (note) note.textContent = ''; return; }
    const p = (Actions._provDir || [])[Number(i)];
    if (!p) return;
    $('p_label').value = p.name;
    if (p.suggested_driver) { $('p_driver').value = p.suggested_driver; Actions.providerDriverHint(); }
    if (note) note.innerHTML = `${esc(p.notes || '')} ${p.website ? `· <a href="${esc(p.website)}" target="_blank">website</a>` : ''}
      <br>For a config-driven (dynamic) provider, build the request/response mapping in <a href="#/aistudio">🤖 AI Integration Studio</a> from ${esc(p.name)}'s API docs, then paste it into Advanced config below.`;
  },
  providerDriverHint() {
    const d = val('p_driver');
    const hints = {
      aeronpay: ['AeronPay — headers client-id / client-secret.', 'API key = client-id', 'API secret = client-secret'],
      eko: ['Eko — dynamic signed headers. Partner ID = initiator_id; put user_code in Advanced config.', 'API key = developer_key', 'API secret = access_key (used to sign each request)'],
    };
    const h = hints[d];
    $('p_hint').textContent = h ? h[0] : '';
    $('p_key_l').textContent = h ? h[1] : 'API key';
    $('p_secret_l').textContent = h ? h[2] : 'API secret';
    $('p_partner_l').textContent = d === 'eko' ? 'Partner ID (initiator_id)' : 'Partner ID';
  },
  editProviderSecret(id, label) {
    UI.modal(`<h3>Callback secret — ${esc(label)}</h3>
      <p class="muted">The provider signs each callback with <code>HMAC-SHA256(body, secret)</code> and sends it as the <code>X-Webhook-Signature</code> header. Set the same secret here and with the provider.</p>
      <div class="field"><label>Secret</label><input id="pw_secret" placeholder="new secret"></div>
      <div class="foot"><button class="btn" onclick="Actions.saveProviderSecret('${id}')">Save</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveProviderSecret(id) {
    const secret = val('pw_secret');
    if (!secret) return UI.toast('Enter a secret', 'err');
    try { await Api.patch(`/admin/providers/${id}`, { webhook_secret: secret }); UI.closeModal(); UI.toast('Callback secret saved'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  copyText(t) {
    try { navigator.clipboard.writeText(t); UI.toast('Copied'); }
    catch { UI.toast('Copy failed — select manually', 'err'); }
  },
  async testProvider(id, label) {
    UI.modal(`<h3>Testing ${esc(label)}…</h3><p class="muted" id="pt_body">Running a connectivity check (no live transaction)…</p>`);
    try {
      const r = await Api.post(`/admin/providers/${id}/test`, {});
      const rowHtml = (r.checks || []).map(c => `<div class="row" style="gap:8px;align-items:center">
        <span style="font-size:15px">${c.ok?'✅':'❌'}</span><b>${esc(c.label)}</b>
        <span class="muted" style="font-size:12px">${esc(c.detail||'')}</span></div>`).join('');
      const banner = r.ok
        ? `<div class="msg" style="background:#e6f4ea;color:#137333;padding:10px;border-radius:8px">${esc(r.message)}</div>`
        : `<div class="msg err">${esc(r.message)}</div>`;
      UI.modal(`<h3>${esc(label)} — ${r.mode==='sandbox'?'sandbox':(r.ok?'ready':'not ready')}</h3>
        ${banner}<div class="mt" style="display:flex;flex-direction:column;gap:6px">${rowHtml}</div>
        <div class="row mt" style="justify-content:flex-end"><button class="btn sm" onclick="UI.closeModal()">Close</button></div>`);
    } catch (err) { UI.modal(`<h3>${esc(label)}</h3><div class="msg err">${esc(err.message)}</div>
        <div class="row mt" style="justify-content:flex-end"><button class="btn sm" onclick="UI.closeModal()">Close</button></div>`); }
  },
  async deactivateProvider(id) {
    try { await Api.post(`/admin/providers/${id}/deactivate`, {}); UI.toast('Deactivated'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // ----- catalog: operators -----
  addOperator() {
    UI.modal(`<h3>Add / update operator</h3>
      <div class="field"><label>Code (A-Z, 0-9, _)</label><input id="op_code" placeholder="JIO"></div>
      <div class="field"><label>Name</label><input id="op_name" placeholder="Jio"></div>
      <div class="field"><label>Type</label><select id="op_type"><option value="prepaid">prepaid</option><option value="postpaid">postpaid</option><option value="dth">dth</option></select></div>
      <div class="row mt" style="justify-content:flex-end;gap:8px"><button class="btn ghost" onclick="UI.closeModal()">Cancel</button>
        <button class="btn" onclick="Actions.saveOperator()">Save</button></div>`);
  },
  async saveOperator() {
    const body = { code: val('op_code').toUpperCase(), name: val('op_name'), type: val('op_type') };
    if (!/^[A-Z0-9_]+$/.test(body.code) || !body.name) return UI.toast('Enter a code and name', 'err');
    try { await Api.post('/admin/operators', body); UI.closeModal(); UI.toast('Operator saved'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async toggleOperator(code, enabled) {
    // Re-send the row with the flipped enabled flag (upsert).
    try {
      const d = await Api.get('/admin/operators');
      const o = (d.items || []).find(x => x.code === code); if (!o) return;
      await Api.post('/admin/operators', { code: o.code, name: o.name, type: o.type, enabled, sort_order: o.sort_order });
      UI.toast(enabled ? 'Enabled' : 'Disabled'); App.route();
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async delOperator(code) {
    if (!confirm('Delete operator ' + code + '?')) return;
    try { await Api.del('/admin/operators/' + encodeURIComponent(code)); UI.toast('Deleted'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  // ----- catalog: billers -----
  addBiller() {
    UI.modal(`<h3>Add / update biller</h3>
      <div class="field"><label>Biller ID</label><input id="bl_id" placeholder="ELEC-UPPCL"></div>
      <div class="field"><label>Name</label><input id="bl_name" placeholder="UPPCL Uttar Pradesh"></div>
      <div class="field"><label>Category</label><input id="bl_cat" placeholder="electricity"></div>
      <div class="field"><label>Coverage</label><select id="bl_cov"><option value="national">national</option><option value="state">state</option></select></div>
      <div class="row mt" style="justify-content:flex-end;gap:8px"><button class="btn ghost" onclick="UI.closeModal()">Cancel</button>
        <button class="btn" onclick="Actions.saveBiller()">Save</button></div>`);
  },
  async saveBiller() {
    const body = { biller_id: val('bl_id'), name: val('bl_name'), category: val('bl_cat'), coverage: val('bl_cov') };
    if (!body.biller_id || !body.name || !body.category) return UI.toast('Fill ID, name and category', 'err');
    try { await Api.post('/admin/billers', body); UI.closeModal(); UI.toast('Biller saved'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async toggleBiller(id, enabled) {
    try {
      const d = await Api.get('/admin/billers');
      const b = (d.items || []).find(x => x.biller_id === id); if (!b) return;
      await Api.post('/admin/billers', { biller_id: b.biller_id, name: b.name, category: b.category, coverage: b.coverage || 'national', enabled });
      UI.toast(enabled ? 'Enabled' : 'Disabled'); App.route();
    } catch (err) { UI.toast(err.message, 'err'); }
  },
  async delBiller(id) {
    if (!confirm('Delete biller ' + id + '?')) return;
    try { await Api.del('/admin/billers/' + encodeURIComponent(id)); UI.toast('Deleted'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async activateProvider(id) {
    try { await Api.post(`/admin/providers/${id}/activate`, {}); UI.toast('Activated'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async deleteProvider(id) {
    if (!confirm('Delete this provider?')) return;
    try { await Api.del(`/admin/providers/${id}`); UI.toast('Deleted'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  addRule(planId) {
    UI.modal(`<h3>Add commission rule</h3>
      <div class="field"><label>Service code</label><input id="r_svc" placeholder="recharge" onchange="Actions.loadRuleProviders()" onblur="Actions.loadRuleProviders()"></div>
      <div class="field"><label>Provider (optional)</label>
        <select id="r_prov"><option value="">All providers (default rate)</option></select>
        <div class="muted" style="font-size:12px;margin-top:4px">Pick a provider to set a different commission just for that API (e.g. Recharge 1 vs Recharge 2).</div></div>
      <div class="field"><label>Charge type</label><select id="r_ct"><option>flat</option><option>percent</option></select></div>
      <div class="field"><label>Charge value (₹ or %)</label><input id="r_cv" type="number" value="0"></div>
      <div class="field"><label>Retailer</label><input id="r_ret" type="number" value="0"></div>
      <div class="field"><label>Distributor</label><input id="r_dist" type="number" value="0"></div>
      <div class="field"><label>Master distributor</label><input id="r_md" type="number" value="0"></div>
      <div class="field"><label>Admin</label><input id="r_adm" type="number" value="0"></div>
      <div class="field"><label>Commission type</label><select id="r_lt"><option>percent</option><option>flat</option></select></div>
      <div class="foot"><button class="btn" onclick="Actions.saveRule('${planId}')">Add</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  _planId: null,
  createPlan() {
    UI.modal(`<h3>New commission plan</h3>
      <div class="field"><label>Plan name</label><input id="pl_name" placeholder="e.g. Premium Retailers"></div>
      <div class="field"><label>Description (optional)</label><input id="pl_desc"></div>
      <div class="field"><label><input type="checkbox" id="pl_def"> Make this the default plan</label></div>
      <div class="foot"><button class="btn" onclick="Actions.savePlan()">Create</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async savePlan() {
    const name = val('pl_name'); if (!name || name.length < 2) return UI.toast('Enter a plan name', 'err');
    try { const r = await Api.post('/admin/commission-plans', { name, description: val('pl_desc'), is_default: $('pl_def').checked });
      Actions._planId = r.plan.id; UI.closeModal(); UI.toast('Plan created'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async setDefaultPlan(id) {
    try { await Api.patch('/admin/commission-plans/' + id, { is_default: true }); UI.toast('Default plan set'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async deletePlan(id) {
    if (!confirm('Delete this plan? Members on it fall back to the default.')) return;
    try { await Api.del('/admin/commission-plans/' + id); Actions._planId = null; UI.toast('Plan deleted'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async deleteRule(planId, ruleId) {
    if (!confirm('Delete this rule?')) return;
    try { await Api.del(`/admin/commission-plans/${planId}/rules/${ruleId}`); UI.toast('Rule deleted'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async setUserPlan(id, name, current) {
    const d = await Api.get('/admin/commission-plans').catch(() => ({ items: [] }));
    const opts = ['<option value="">Default plan</option>']
      .concat((d.items || []).map(p => `<option value="${p.id}" ${p.id===current?'selected':''}>${esc(p.name)}${p.is_default?' (default)':''}</option>`))
      .join('');
    UI.modal(`<h3>Commission plan — ${esc(name)}</h3>
      <p class="muted" style="font-size:13px">Assign a commission plan to this member. "Default plan" means they use whichever plan is marked default.</p>
      <div class="field"><label>Plan</label><select id="up_plan">${opts}</select></div>
      <div class="foot"><button class="btn" onclick="Actions.saveUserPlan('${id}')">Save</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveUserPlan(id) {
    const v = val('up_plan');
    try { await Api.patch(`/admin/users/${id}/plan`, { commission_plan_id: v || null }); UI.closeModal(); UI.toast('Plan assigned'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async loadRuleProviders() {
    const code = val('r_svc'); const sel = $('r_prov'); if (!code || !sel) return;
    try {
      const d = await Api.get(`/admin/services/${encodeURIComponent(code)}/providers`);
      const opts = ['<option value="">All providers (default rate)</option>']
        .concat((d.items || []).map(p => `<option value="${esc(p.id)}">${esc(p.label)}${p.is_active?'':' (inactive)'}</option>`));
      sel.innerHTML = opts.join('');
    } catch { /* leave default option */ }
  },
  async saveRule(planId) {
    const lt = val('r_lt');
    const body = { service_code: val('r_svc'), charge_type: val('r_ct'), charge_value: +val('r_cv'),
      retailer_type: lt, retailer_value: +val('r_ret'), distributor_type: lt, distributor_value: +val('r_dist'),
      master_distributor_type: lt, master_distributor_value: +val('r_md'), admin_type: lt, admin_value: +val('r_adm') };
    if (val('r_prov')) body.provider_id = val('r_prov');
    try { await Api.post(`/admin/commission-plans/${planId}/rules`, body); UI.closeModal(); UI.toast('Rule added'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
};

// ---------------- small utils ----------------
function val(id) { return $(id).value.trim(); }
function rank(r) { return ({ user:0, retailer:1, distributor:2, master_distributor:3, admin:4 })[r] ?? 0; }
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------- start ----------------
// Admin console chrome: no public sign-up, distinct heading, no marketing poster.
if (ADMIN_PORTAL) {
  document.title = 'TutiPays — Admin Console';
  const tabSignup = $('tab-signup'); if (tabSignup) tabSignup.style.display = 'none';
  const tabLogin = $('tab-login'); if (tabLogin) tabLogin.style.display = 'none';
  const poster = $('auth-poster'); if (poster) poster.style.display = 'none';
  const brand = document.querySelector('#auth .brand');
  if (brand) brand.innerHTML = 'TutiPays <small>Super Admin Console — authorised staff only</small>';
  const wrap = document.querySelector('#auth .auth-wrap'); if (wrap) wrap.style.gridTemplateColumns = '1fr';
  const card = document.querySelector('#auth .auth-card'); if (card) card.style.margin = '0 auto';
}
App.applyBranding();
if (State.token) App.boot();
else UI.authTab(ADMIN_PORTAL ? 'login' : (new URLSearchParams(location.search).has('signup') ? 'signup' : 'login'));
