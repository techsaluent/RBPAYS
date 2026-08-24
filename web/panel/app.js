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
  { key: 'mydisputes', label: 'My Disputes', roles: NETWORK_ROLES },
  { key: 'network', label: 'My Network', roles: MGMT_ROLES },
  { key: 'kyc', label: 'My KYC', roles: NETWORK_ROLES },
  { key: 'tax', label: 'PAN & TDS', roles: NETWORK_ROLES },
  { key: 'profile', label: 'Profile', roles: '*' },
  { key: 'security', label: 'Security', roles: '*' },
  // Admin console — grouped into sidebar sections; each maps to a staff permission.
  { key: 'members', label: 'Users', roles: ['admin', 'staff'], perm: 'users.view', section: 'Users & KYC' },
  { key: 'kycreview', label: 'KYC Review', roles: ['admin', 'staff'], perm: 'kyc.review', section: 'Users & KYC' },
  { key: 'topupreview', label: 'Top-up Requests', roles: ['admin', 'staff'], perm: 'topup.manage', section: 'Finance' },
  { key: 'withdrawals', label: 'Withdrawals', roles: ['admin', 'staff'], perm: 'payouts.manage', section: 'Finance' },
  { key: 'bankaccounts', label: 'Bank Accounts', roles: ['admin', 'staff'], perm: 'topup.manage', section: 'Finance' },
  { key: 'plans', label: 'Commission', roles: ['admin', 'staff'], perm: 'commission.manage', section: 'Finance' },
  { key: 'taxdesk', label: 'Tax (TDS/GST)', roles: ['admin', 'staff'], perm: 'tax.manage', section: 'Finance' },
  { key: 'recon', label: 'Reconciliation', roles: ['admin', 'staff'], perm: 'recon.manage', section: 'Finance' },
  { key: 'batchpayout', label: 'Batch Payouts', roles: ['admin', 'staff'], perm: 'payouts.manage', section: 'Finance' },
  { key: 'treasury', label: 'Treasury', roles: ['admin', 'staff'], perm: 'payouts.manage', section: 'Finance' },
  { key: 'adminservices', label: 'Services', roles: ['admin', 'staff'], perm: 'providers.manage', section: 'API & Providers' },
  { key: 'providers', label: 'Providers', roles: ['admin', 'staff'], perm: 'providers.manage', section: 'API & Providers' },
  { key: 'integrations', label: 'Integrations', roles: ['admin', 'staff'], perm: 'integrations.manage', section: 'API & Providers' },
  { key: 'webhooks', label: 'Webhook Log', roles: ['admin', 'staff'], perm: 'integrations.manage', section: 'API & Providers' },
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
      // Distributor / Master distributor — network + earnings, no transactions.
      const [p, w, st] = await Promise.all([
        Api.get('/network/panel').catch(() => null),
        Api.get('/wallet'),
        Api.get('/transactions/stats/summary').catch(() => null),
      ]);
      const earn = p ? p.earnings.total_paise / 100 : 0;
      const totalDown = p ? Object.values(p.downline_counts || {}).reduce((a, n) => a + Number(n), 0) : 0;
      const dc = p ? Object.entries(p.downline_counts || {}).map(([k, n]) => `${k.replace(/_/g,' ')}: <b>${n}</b>`).join(' &nbsp; ') : '';
      const recent = (p?.earnings.recent || []).map(e => `<tr><td>${esc(e.service_code)}</td><td>${esc(e.level)}</td><td class="right">${money(e.amount_paise/100)}</td></tr>`).join('');
      $('view').innerHTML = `
        <div class="stats">
          ${UI.stat('b','👛','Wallet balance', money(w.wallet.balance), 'Available float')}
          ${UI.stat('g','💰','Commission earned', money(earn), 'Net of TDS, lifetime')}
          ${UI.stat('o','🧑‍🤝‍🧑','My network', totalDown, dc || 'No members yet')}
          ${st ? UI.stat('t','📈','This month GTV', money((st.month_amount_paise||0)/100), `<b>${st.today_count||0}</b> today`) : ''}
        </div>
        ${st && st.daily ? `<div class="panel mt"><div class="row" style="justify-content:space-between"><h2>Network volume — last 7 days</h2>
          <span class="muted" style="font-size:12px">Successful ₹ per day</span></div>
          ${Charts.area(st.daily.map(x => ({ day: x.day, value: x.amount_paise })), { fmt: Charts.money })}</div>` : ''}
        <div class="panel mt"><h2>Quick actions</h2>
          <a class="btn sm" href="#/network">Manage network</a> &nbsp;
          <a class="btn sm ghost" href="#/addmoney">Add money</a> &nbsp;
          <a class="btn sm ghost" href="#/txns">Transactions</a></div>
        <div class="panel mt"><h2>Recent commission</h2><div class="tbl-wrap"><table>
          <thead><tr><th>Service</th><th>Level</th><th class="right">Amount</th></tr></thead>
          <tbody>${recent || '<tr><td colspan=3 class=muted>None yet</td></tr>'}</tbody></table></div></div>`;
    } else {
      // Retailer (and plain user) — transact, wallet, KYC prompt.
      const [w, kyc, st] = await Promise.all([
        Api.get('/wallet'),
        Api.get('/kyc').catch(() => null),
        Api.get('/transactions/stats/summary').catch(() => null),
      ]);
      const kstat = kyc?.kyc_status || State.user.kyc_status;
      const kycBanner = kstat !== 'verified'
        ? `<div class="msg ${kstat === 'rejected' ? 'err' : ''}" style="background:${kstat==='rejected'?'':'#fef7e0'};color:${kstat==='rejected'?'':'#b06000'}">
             Your KYC is <b>${esc(kstat)}</b>. <a href="#/kyc">Complete KYC →</a></div>` : '';
      const sw = w.sub_wallets || { settlement: '0.00', commission: '0.00' };
      const s = st || {};
      const quick = SERVICES.slice(0, 8).map(x => `<a class="btn sm ghost" href="#/new" onclick="Actions.presetSvc('${x.key}')">${esc(x.label)}</a>`).join(' ');
      $('view').innerHTML = `
        ${kycBanner}
        <div class="stats">
          ${UI.stat('b','👛','Main wallet', money(w.wallet.balance), 'Available balance')}
          ${UI.stat('t','🏧','AePS settlement', money(sw.settlement), 'Pending sweep')}
          ${UI.stat('g','💰','Commission', money(sw.commission), 'Net of TDS')}
          ${UI.stat('p','💳','Today', money((s.today_amount_paise||0)/100), `<b>${s.today_count||0}</b> transactions`)}
          ${UI.stat('t','📈','This month', money((s.month_amount_paise||0)/100), 'Successful value')}
          ${UI.stat('o','🎯','Success rate', (s.success_rate??0)+'%', `<b>${s.success_count||0}</b> of ${s.total_count||0}`)}
        </div>
        ${s.daily ? `<div class="panel mt"><div class="row" style="justify-content:space-between"><h2>My volume — last 7 days</h2>
          <span class="muted" style="font-size:12px">Successful ₹ per day</span></div>
          ${Charts.area(s.daily.map(x => ({ day: x.day, value: x.amount_paise })), { fmt: Charts.money })}</div>` : ''}
        <div class="sechead">Banking counter</div>
        <div class="panel"><div class="row" style="flex-wrap:wrap;gap:8px">${quick}</div></div>
        <div class="panel mt"><h2>Quick actions</h2>
          <a class="btn sm" href="#/new">＋ New transaction</a> &nbsp;
          <a class="btn sm ghost" href="#/addmoney">Add money</a> &nbsp;
          <a class="btn sm ghost" href="#/wallet">Wallets &amp; sweep</a> &nbsp;
          <a class="btn sm ghost" href="#/txns">View transactions</a></div>`;
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

  // Account security: change password, set/remove login MPIN.
  async security() {
    const s = await Api.get('/security').catch(() => ({ mpin_set: false }));
    $('view').innerHTML = `
      <div class="grid cards"><div class="card"><div class="k">Login MPIN (PIN)</div>
        <div class="v" style="font-size:18px">${s.mpin_set ? UI.statusTag('verified') : '<span class="tag">not set</span>'}</div></div></div>
      <div class="panel mt" style="max-width:480px"><h2>Change password</h2>
        <div class="field"><label>Current password</label><input id="cp_cur" type="password"></div>
        <div class="field"><label>New password (min 8)</label><input id="cp_new" type="password"></div>
        <button class="btn" onclick="Actions.changePassword()">Update password</button></div>
      <div class="panel mt" style="max-width:480px"><h2>Login MPIN (PIN instead of OTP)</h2>
        <p class="muted">Set a 4-6 digit PIN. Once set, it's required as a second step at every login.</p>
        <div class="field"><label>Current password</label><input id="mp_pw" type="password"></div>
        <div class="field"><label>${s.mpin_set ? 'New ' : ''}MPIN (4-6 digits)</label><input id="mp_pin" type="password" inputmode="numeric" maxlength="6"></div>
        <button class="btn" onclick="Actions.setMpin()">${s.mpin_set ? 'Change' : 'Set'} MPIN</button>
        ${s.mpin_set ? `<button class="btn ghost mt" onclick="Actions.removeMpin()">Remove MPIN</button>` : ''}</div>`;
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
        <button class="btn sm" onclick="Actions.topup()">Top up (test gateway)</button></div>
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
      <div class="panel mt"><h2>My TDS statement</h2><div class="tbl-wrap"><table>
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
    $('view').innerHTML = `<div class="panel"><h2>All transactions</h2><div class="tbl-wrap"><table>
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
      <td class="muted">${new Date(x.created_at).toLocaleDateString('en-IN')}</td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>My disputes</h2>
      <button class="btn sm" onclick="Actions.raiseDispute()">+ Raise dispute</button></div>
      <p class="muted">Raise a complaint on a transaction (by reference id). Our team tracks and resolves it.</p>
      <div class="tbl-wrap"><table><thead><tr><th>Ticket</th><th>Ref</th><th>Category</th><th>Status</th><th>Resolution</th><th>When</th></tr></thead>
      <tbody>${rows || '<tr><td colspan=6 class=muted>No disputes raised.</td></tr>'}</tbody></table></div></div>`;
  },
  // Admin/staff: disputes desk, searchable by reference / ticket.
  async disputes() {
    const q = Actions._dispSearch || '';
    const st = Actions._dispStatus || '';
    const d = await Api.get(`/admin/disputes?limit=100${q?'&q='+encodeURIComponent(q):''}${st?'&status='+st:''}`);
    const rows = (d.items || []).map(x => `<tr>
      <td class="mono">${esc(x.ticket_no||'')}</td>
      <td class="muted">${esc(x.reference||'')}<div style="font-size:11px">${esc(x.txn_service||'')} ${x.txn_amount_paise?money(x.txn_amount_paise/100):''}</div></td>
      <td>${esc(x.raised_by_name||'')}<div class="muted" style="font-size:11px">${esc(x.raised_by_phone||'')}</div></td>
      <td>${esc((x.category||'').replace(/_/g,' '))}<div class="muted" style="font-size:11px;max-width:220px;white-space:normal">${esc(x.description||'')}</div></td>
      <td>${UI.statusTag(x.status)}</td>
      <td>${['open','in_review'].includes(x.status)
        ? `<button class="btn sm" onclick="Actions.resolveDispute('${x.id}','resolved')">Resolve</button>
           <button class="btn sm ghost" onclick="Actions.resolveDispute('${x.id}','in_review')">In review</button>
           <button class="btn sm ghost" onclick="Actions.resolveDispute('${x.id}','rejected')">Reject</button>`
        : `<span class="muted">${esc(x.resolution||'')}</span>`}</td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><h2>Disputes / complaints desk</h2>
      <div class="row" style="gap:8px;margin-bottom:12px">
        <input id="disp_q" placeholder="Search by reference or ticket…" value="${esc(q)}" style="max-width:280px" onkeydown="if(event.key==='Enter')Actions.disputeSearch()">
        <select id="disp_status" onchange="Actions._dispStatus=this.value;Actions.disputeSearch()">
          <option value="">All statuses</option>
          ${['open','in_review','resolved','rejected'].map(s=>`<option value="${s}" ${st===s?'selected':''}>${s}</option>`).join('')}</select>
        <button class="btn sm" onclick="Actions.disputeSearch()">Search</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Ticket</th><th>Txn / ref</th><th>Raised by</th><th>Complaint</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=6 class=muted>No disputes found.</td></tr>'}</tbody></table></div></div>`;
  },

  // Incoming provider callbacks / webhooks log.
  async webhooks() {
    const d = await Api.get('/admin/provider-events?limit=100');
    const rows = (d.items || []).map(e => `<tr>
      <td class="muted" style="white-space:nowrap">${new Date(e.received_at).toLocaleString('en-IN')}</td>
      <td>${esc(e.provider)}</td><td>${esc(e.event_type||'')}</td>
      <td class="muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(e.external_id||'')}</td>
      <td>${e.processed ? '<span class="tag active">processed</span>' : '<span class="tag">received</span>'}</td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><h2>Webhook / callback log</h2>
      <p class="muted">Every signed callback from your providers (payout / DMT / recharge / gateway). Each is verified, de-duplicated and settled. Configure the callback URLs &amp; secret under <a href="#/website">Website</a>.</p>
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
      <td>${UI.statusTag(s.status)}</td>
      <td>${(s.permissions||[]).length} power(s)</td>
      <td>
        <button class="btn sm" onclick='Actions.editStaff(${JSON.stringify(s).replace(/'/g,"&#39;")})'>Permissions</button>
        ${s.status === 'active'
          ? `<button class="btn sm ghost" onclick="Actions.staffStatus('${s.id}','suspended')">Suspend</button>`
          : `<button class="btn sm" onclick="Actions.staffStatus('${s.id}','active')">Activate</button>`}
      </td></tr>`).join('');
    $('view').innerHTML = `
      <div class="panel"><div class="row" style="justify-content:space-between"><h2>Staff &amp; roles</h2>
        <button class="btn sm" onclick="Actions.addStaff()">+ Add staff</button></div>
        <p class="muted">Staff log in through this admin console but only see the sections you grant. The super admin holds every power.</p>
        <div class="tbl-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Powers</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan=5 class=muted>No staff yet — add your first team member.</td></tr>'}</tbody></table></div></div>`;
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
    const plan = d.items[0];
    if (!plan) { $('view').innerHTML = '<div class="panel muted">No commission plan found.</div>'; return; }
    const full = await Api.get('/admin/commission-plans/' + plan.id);
    const rows = full.rules.map(r => `<tr><td>${esc(r.service_code)}</td>
      <td>${money(r.min_amount_paise/100)}–${r.max_amount_paise > 1e15 ? '∞' : money(r.max_amount_paise/100)}</td>
      <td>${esc(r.charge_type)} ${r.charge_value}</td>
      <td>R:${r.retailer_value} D:${r.distributor_value} MD:${r.master_distributor_value} A:${r.admin_value}</td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between">
      <h2>Plan: ${esc(plan.name)}</h2><button class="btn sm" onclick="Actions.addRule('${plan.id}')">+ Add rule</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Service</th><th>Slab</th><th>Charge</th><th>Commission (%/flat)</th></tr></thead>
      <tbody>${rows || '<tr><td colspan=4 class=muted>No rules — add one so commissions apply</td></tr>'}</tbody></table></div></div>`;
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
      <div class="panel mt"><h2>TDS records (Section 194H / 194N)</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Member</th><th>Service</th><th>Section</th><th class="right">Gross</th><th>Rate</th><th class="right">TDS</th><th>When</th></tr></thead>
        <tbody>${trows || '<tr><td colspan=7 class=muted>No TDS yet</td></tr>'}</tbody></table></div></div>
      <div class="panel mt"><h2>GST invoices (18% on platform margin)</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Service</th><th class="right">Base</th><th class="right">CGST</th><th class="right">SGST</th><th class="right">IGST</th><th>PoS</th></tr></thead>
        <tbody>${grows || '<tr><td colspan=6 class=muted>No GST yet</td></tr>'}</tbody></table></div></div>`;
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
  async resolveDispute(id, status) {
    const label = status === 'resolved' ? 'Resolve' : status === 'rejected' ? 'Reject' : 'Mark in-review';
    const resolution = prompt(`${label} — enter a resolution note (required):`, '');
    if (resolution === null) return;
    if (!resolution.trim()) return UI.toast('A resolution note is required', 'err');
    try { await Api.post(`/admin/disputes/${id}/resolve`, { status, resolution: resolution.trim() }); UI.toast('Dispute ' + status); App.route(); }
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
        ${field('security_admin_ip_allowlist','Admin login IP allowlist','1.2.3.4, 10.0.0.0/24 — blank = any')}
        <p class="muted">Restrict super-admin logins to these IPs/CIDRs (comma-separated). Leave blank to allow admin login from anywhere. The admin portal lives at a separate URL (<code>/admin</code>); this allowlist is the real lock behind it.</p>
        <h2 class="mt">Webhooks &amp; callbacks</h2>
        <p class="muted">Give these callback URLs to your payout / DMT / recharge provider. The aggregator secret below signs incoming callbacks (HMAC-SHA256).</p>
        <div class="field"><label>Aggregator callback URL</label><input value="${esc(location.origin)}/api/v1/webhooks/aggregator" readonly onclick="this.select()"></div>
        <div class="field"><label>Razorpay callback URL</label><input value="${esc(location.origin)}/api/v1/webhooks/razorpay" readonly onclick="this.select()"></div>
        ${field('aggregator_webhook_secret','Aggregator webhook secret (HMAC key)')}
        <h2 class="mt">Automation (n8n / AI agent)</h2>
        <p class="muted">Platform events (disputes, etc.) are POSTed to this URL as <code>{event, at, data}</code> — wire it to an n8n workflow or an AI-agent that acts as staff.</p>
        ${field('automation_webhook_url','Automation / n8n webhook URL','https://n8n.yourhost/webhook/…')}
        <button class="btn mt" onclick="Actions.saveSite()">Save branding</button></div>
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
      <td>${p.is_active
          ? `<button class="btn sm ghost" onclick="Actions.deactivateProvider('${p.id}')">Deactivate</button>`
          : `<button class="btn sm" onclick="Actions.activateProvider('${p.id}')">Activate</button>`}
          <button class="btn sm ghost" onclick="Actions.deleteProvider('${p.id}')">Delete</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between">
      <h2>Service providers</h2><button class="btn sm" onclick="Actions.addProvider('${sel}')">+ Add provider</button></div>
      <div class="field" style="max-width:360px"><label>Service</label>
        <select id="prov_svc" onchange="Actions._provService=this.value;App.route()">${opts}</select></div>
      <p class="muted">Register one or more providers per service and activate the one to route through. Paste API keys here — going live is just adding keys and activating.</p>
      <div class="tbl-wrap"><table>
      <thead><tr><th>Label</th><th>Driver</th><th>Base URL</th><th>Active</th><th>Key</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan=6 class=muted>No providers — add one</td></tr>'}</tbody></table></div></div>`;
  },
};

// ---------------- Service definitions for the "New transaction" form ----------------
const SERVICES = [
  { key: 'recharge', label: 'Recharge', path: '/recharge', provider: true, fields: [
    ['recharge_type', 'Type', 'select', ['prepaid', 'postpaid', 'dth']],
    ['operator', 'Operator', 'select', ['Jio', 'Airtel', 'Vi', 'BSNL', 'Tata Play (DTH)', 'Dish TV (DTH)', 'Airtel Digital TV (DTH)', 'd2h (DTH)', 'Sun Direct (DTH)']],
    ['number', 'Mobile / DTH number', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ operator: v.operator, number: v.number, amount: +v.amount, recharge_type: v.recharge_type || 'prepaid' }) },
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
];

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
    } else { box.innerHTML = ''; }
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
  async addStaff() {
    UI.modal(`<h3>Add staff member</h3>
      <div class="field"><label>Full name</label><input id="st_name"></div>
      <div class="field"><label>Email</label><input id="st_email" type="email"></div>
      <div class="field"><label>Mobile (10 digit)</label><input id="st_phone"></div>
      <div class="field"><label>Temporary password (min 8)</label><input id="st_pw" type="password"></div>
      <h4 style="margin:14px 0 6px">Powers</h4>
      <div style="max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:12px">${Actions._permBoxes([])}</div>
      <div class="foot"><button class="btn" onclick="Actions.saveNewStaff()">Create staff</button>
        <button class="btn ghost" onclick="UI.closeModal()">Cancel</button></div>`);
  },
  async saveNewStaff() {
    const body = { full_name: val('st_name'), email: val('st_email'), phone: val('st_phone'),
      password: $('st_pw').value, permissions: Actions._collectPerms() };
    try { await Api.post('/staff', body); UI.closeModal(); UI.toast('Staff member added'); App.route(); }
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
    const keys = ['brand_name','logo_emoji','logo_url','primary_color','tagline','support_email','admin_email','phone','company_name','company_address','auth_poster_url','auth_poster_title','auth_poster_subtitle','auth_poster_link','security_admin_ip_allowlist','aggregator_webhook_secret','automation_webhook_url'];
    const values = {}; keys.forEach(k => values[k] = val('ws_'+k));
    values['security_require_txn_mpin'] = $('ws_security_require_txn_mpin').checked ? 'true' : 'false';
    values['security_require_signup_otp'] = $('ws_security_require_signup_otp').checked ? 'true' : 'false';
    try { await Api.put('/admin/site/settings', { values }); UI.toast('Branding saved'); App.applyBranding(); App.route(); }
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
  _provService: null,
  addProvider(code) {
    UI.modal(`<h3>Add provider — ${esc(code)}</h3>
      <div class="field"><label>Label</label><input id="p_label" placeholder="Paysprint / RazorpayX"></div>
      <div class="field"><label>Driver</label><select id="p_driver">
        <option value="sandbox">sandbox (test)</option><option value="aggregator">aggregator (DMT/BBPS/recharge switch)</option>
        <option value="razorpay">razorpay (payout/gateway)</option><option value="generic">generic</option></select></div>
      <div class="field"><label>Base URL</label><input id="p_url" placeholder="https://api.provider.com"></div>
      <div class="field"><label>API key</label><input id="p_key"></div>
      <div class="field"><label>API secret</label><input id="p_secret"></div>
      <div class="field"><label>Auth token</label><input id="p_token"></div>
      <div class="field"><label>Partner ID</label><input id="p_partner"></div>
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
    try { await Api.post(`/admin/services/${code}/providers`, body); UI.closeModal(); UI.toast('Provider added'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async deactivateProvider(id) {
    try { await Api.post(`/admin/providers/${id}/deactivate`, {}); UI.toast('Deactivated'); App.route(); }
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
