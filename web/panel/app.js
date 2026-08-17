/* RBPAYS Panel — talks to the RBPAYS API. Pure vanilla JS, no build step. */

// ------- Config: point this at your API. Override via ?api= or window.RBPAYS_API -------
// Auto-selects the API by the domain the panel is served from, so the same files
// work on tutipays.com and (during migration) rbpays.in.
function defaultApiBase() {
  const q = new URLSearchParams(location.search).get('api');
  if (q) return q;
  if (window.RBPAYS_API) return window.RBPAYS_API;
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
    if (!res.ok) throw new Error(data?.error?.message || ('HTTP ' + res.status));
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
    try {
      const d = await Api.post('/auth/login', {
        identifier: f.identifier.value.trim(), password: f.password.value,
      }, false);
      Auth.save(d); await App.boot();
    } catch (err) { UI.authMsg(err.message, 'err'); }
    return false;
  },
  async signup(e) {
    e.preventDefault();
    const f = e.target;
    const body = { full_name: f.full_name.value.trim(), email: f.email.value.trim(),
      phone: f.phone.value.trim(), password: f.password.value };
    if (f.username.value.trim()) body.username = f.username.value.trim();
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
  { key: 'wallet', label: 'Wallet', roles: NETWORK_ROLES },
  { key: 'addmoney', label: 'Add Money', roles: NETWORK_ROLES },
  { key: 'txns', label: 'Transactions', roles: NETWORK_ROLES },
  { key: 'network', label: 'My Network', roles: MGMT_ROLES },
  { key: 'kyc', label: 'My KYC', roles: NETWORK_ROLES },
  { key: 'tax', label: 'PAN & TDS', roles: NETWORK_ROLES },
  { key: 'members', label: 'Users', roles: ['admin'] },
  { key: 'kycreview', label: 'KYC Review', roles: ['admin'] },
  { key: 'topupreview', label: 'Top-up Requests', roles: ['admin'] },
  { key: 'bankaccounts', label: 'Bank Accounts', roles: ['admin'] },
  { key: 'plans', label: 'Commission', roles: ['admin'] },
  { key: 'adminservices', label: 'Services', roles: ['admin'] },
  { key: 'providers', label: 'Providers', roles: ['admin'] },
  { key: 'integrations', label: 'Integrations', roles: ['admin'] },
  { key: 'taxdesk', label: 'Tax (TDS/GST)', roles: ['admin'] },
  { key: 'risk', label: 'Risk & AML', roles: ['admin'] },
  { key: 'recon', label: 'Reconciliation', roles: ['admin'] },
  { key: 'opsdesk', label: 'Ops Desk', roles: ['admin'] },
  { key: 'ledger', label: 'Ledger', roles: ['admin'] },
];
function allowed(item) { return item.roles === '*' || item.roles.includes(State.user.role); }

// ---------------- App bootstrap + router ----------------
const App = {
  async boot() {
    try {
      if (!State.user) { const me = await Api.get('/auth/me'); State.user = me.user; }
    } catch { return Auth.logout(); }
    $('auth').style.display = 'none'; $('app').style.display = 'grid';
    $('who-name').textContent = State.user.full_name;
    $('who-role').textContent = State.user.role.replace(/_/g, ' ');
    $('nav').innerHTML = NAV.filter(allowed)
      .map(i => `<a href="#/${i.key}" data-k="${i.key}">${i.label}</a>`).join('');
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
    if (State.user.role === 'admin') {
      const d = await Api.get('/admin/dashboard');
      const roles = Object.entries(d.users_by_role || {}).map(([k, n]) => `${k.replace(/_/g,' ')}: <b>${n}</b>`).join(' &nbsp; ');
      const vol = Object.entries(d.service_volumes || {}).map(([k, v]) =>
        `<tr><td>${k}</td><td class="right">${v.success_count}</td><td class="right">${money(v.success_amount_paise/100)}</td></tr>`).join('');
      $('view').innerHTML = `
        <div class="grid cards">
          <div class="card"><div class="k">Wallet float</div><div class="v">${money(d.wallet_float_paise/100)}</div></div>
          <div class="card"><div class="k">Commission paid</div><div class="v">${money(d.commission_paid_paise/100)}</div></div>
          <div class="card"><div class="k">Pending KYC</div><div class="v">${d.pending_kyc}</div></div>
        </div>
        <div class="panel mt"><h2>Users</h2><div>${roles || '—'}</div></div>
        <div class="panel mt"><h2>Service volume (successful)</h2>
          <div class="tbl-wrap"><table><thead><tr><th>Service</th><th class="right">Count</th><th class="right">Amount</th></tr></thead>
          <tbody>${vol}</tbody></table></div></div>`;
    } else if (MGMT_ROLES.includes(State.user.role)) {
      // Distributor / Master distributor — network + earnings, no transactions.
      const [p, w] = await Promise.all([Api.get('/network/panel').catch(() => null), Api.get('/wallet')]);
      const earn = p ? p.earnings.total_paise / 100 : 0;
      const dc = p ? Object.entries(p.downline_counts || {}).map(([k, n]) => `${k.replace(/_/g,' ')}: <b>${n}</b>`).join(' &nbsp; ') : '';
      const recent = (p?.earnings.recent || []).map(e => `<tr><td>${esc(e.service_code)}</td><td>${esc(e.level)}</td><td class="right">${money(e.amount_paise/100)}</td></tr>`).join('');
      $('view').innerHTML = `
        <div class="grid cards">
          <div class="card"><div class="k">Wallet balance</div><div class="v">${money(w.wallet.balance)}</div></div>
          <div class="card"><div class="k">Commission earned</div><div class="v">${money(earn)}</div></div>
        </div>
        <div class="panel mt"><h2>Quick actions</h2>
          <a class="btn sm ghost" href="#/addmoney">Add money</a> &nbsp;
          <a class="btn sm ghost" href="#/network">Manage network</a></div>
        <div class="panel mt"><div class="row" style="justify-content:space-between"><h2>My downline</h2>
          <a class="btn sm" href="#/network">Manage network</a></div><div>${dc || 'No members yet'}</div></div>
        <div class="panel mt"><h2>Recent commission</h2><div class="tbl-wrap"><table>
          <thead><tr><th>Service</th><th>Level</th><th class="right">Amount</th></tr></thead>
          <tbody>${recent || '<tr><td colspan=3 class=muted>None yet</td></tr>'}</tbody></table></div></div>`;
    } else {
      // Retailer (and plain user) — transact, wallet, KYC prompt.
      const [w, kyc] = await Promise.all([Api.get('/wallet'), Api.get('/kyc').catch(() => null)]);
      const kstat = kyc?.kyc_status || State.user.kyc_status;
      const kycBanner = kstat !== 'verified'
        ? `<div class="msg ${kstat === 'rejected' ? 'err' : ''}" style="background:${kstat==='rejected'?'':'#fef7e0'};color:${kstat==='rejected'?'':'#b06000'}">
             Your KYC is <b>${esc(kstat)}</b>. <a href="#/kyc">Complete KYC →</a></div>` : '';
      $('view').innerHTML = `
        ${kycBanner}
        <div class="grid cards">
          <div class="card"><div class="k">Wallet balance</div><div class="v">${money(w.wallet.balance)}</div></div>
          <div class="card"><div class="k">KYC status</div><div class="v" style="font-size:18px">${UI.statusTag(kstat)}</div></div>
        </div>
        <div class="panel mt"><h2>Quick actions</h2>
          <a class="btn sm" href="#/new">＋ New transaction</a> &nbsp;
          <a class="btn sm ghost" href="#/addmoney">Add money</a> &nbsp;
          <a class="btn sm ghost" href="#/txns">View transactions</a></div>`;
    }
  },

  // Member self-service KYC: submit documents and see status.
  async kyc() {
    const d = await Api.get('/kyc').catch(() => ({ kyc_status: 'pending', documents: [] }));
    const rows = (d.documents || []).map(k => `<tr><td>${esc(k.doc_type)}</td><td>${esc(k.doc_number||'')}</td>
      <td>${UI.statusTag(k.status)}</td><td class="muted">${esc(k.remarks||'')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="grid cards"><div class="card"><div class="k">My KYC status</div><div class="v" style="font-size:20px">${UI.statusTag(d.kyc_status)}</div></div></div>
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
    const sw = w.sub_wallets || { settlement: '0.00', commission: '0.00', settlement_paise: 0, commission_paise: 0 };
    const rows = l.items.map(r => `<tr><td>${r.direction === 'credit' ? '＋' : '－'} ${money(r.amount)}</td>
      <td>${esc(r.source)}</td><td class="muted">${esc(r.description || '')}</td>
      <td class="right">${money(r.balance_after)}</td><td class="muted">${new Date(r.created_at).toLocaleString('en-IN')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="grid cards">
        <div class="card"><div class="k">Main wallet</div><div class="v">${money(w.wallet.balance)}</div>
          <a class="btn sm ghost" href="#/addmoney">Add money</a></div>
        <div class="card"><div class="k">AePS settlement</div><div class="v">${money(sw.settlement)}</div>
          ${sw.settlement_paise > 0 ? `<button class="btn sm" onclick="Actions.sweep('settlement',${sw.settlement_paise/100})">Sweep to main</button>` : ''}</div>
        <div class="card"><div class="k">Commission (net of TDS)</div><div class="v">${money(sw.commission)}</div>
          ${sw.commission_paise > 0 ? `<button class="btn sm" onclick="Actions.sweep('commission',${sw.commission_paise/100})">Sweep to main</button>` : ''}</div>
      </div>
      <div class="panel mt"><div class="row" style="justify-content:space-between"><h2>Main wallet ledger</h2>
        <button class="btn sm" onclick="Actions.topup()">Top up (test gateway)</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>Amount</th><th>Source</th><th>Description</th><th class="right">Balance</th><th>When</th></tr></thead>
        <tbody>${rows || '<tr><td colspan=5 class=muted>No transactions yet</td></tr>'}</tbody></table></div></div>`;
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
    Actions.svcFields();
  },

  async txns() {
    const d = await Api.get('/transactions?limit=40');
    const rows = d.items.map(t => `<tr>
      <td>${esc(t.service)}</td><td>${t.direction}</td><td class="right">${money(t.amount)}</td>
      <td class="right">${money(t.net)}</td><td>${UI.statusTag(t.status)}</td>
      <td class="muted">${esc(t.reference)}</td><td class="muted">${new Date(t.created_at).toLocaleString('en-IN')}</td>
      <td><button class="btn sm ghost" onclick="Actions.receipt('${t.id}')">Receipt</button></td></tr>`).join('');
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

  async members() {
    const d = await Api.get('/admin/users?limit=50');
    const rows = d.items.map(u => `<tr>
      <td>${esc(u.full_name)}</td><td>${esc(u.username||'')}</td><td>${esc(u.role)}</td>
      <td>${esc(u.phone)}</td><td>${UI.statusTag(u.status)}</td><td>${UI.statusTag(u.kyc_status)}</td>
      <td>${u.status === 'active'
          ? `<button class="btn sm ghost" onclick="Actions.setStatus('${u.id}','suspended')">Suspend</button>`
          : `<button class="btn sm" onclick="Actions.setStatus('${u.id}','active')">Activate</button>`}</td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between">
      <h2>Users</h2><button class="btn sm" onclick="Actions.addMember(true)">+ Create member</button></div>
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
    const d = await Api.get('/admin/ledger/journal?limit=40');
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
      <p class="muted">Immutable journal — every entry has equal debits and credits.</p></div>${blocks || '<div class="panel muted">No journal entries yet</div>'}`;
  },

  // Admin: TDS (194H/194N) + GST desk.
  async taxdesk() {
    const [tds, gst] = await Promise.all([Api.get('/admin/tds'), Api.get('/admin/gst')]);
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

  // Admin: ops desk — maker-checker manual adjustments.
  async opsdesk() {
    const d = await Api.get('/admin/adjustments');
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
        <tbody>${rows || '<tr><td colspan=7 class=muted>No adjustments</td></tr>'}</tbody></table></div></div>`;
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
      <td>${p.is_active ? '' : `<button class="btn sm" onclick="Actions.activateProvider('${p.id}')">Activate</button>`}
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
  { key: 'recharge', label: 'Recharge', path: '/recharge', fields: [
    ['operator', 'Operator', 'text'], ['number', 'Mobile / DTH number', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ operator: v.operator, number: v.number, amount: +v.amount, recharge_type: 'prepaid' }) },
  { key: 'dmt', label: 'DMT (bank transfer)', path: '/dmt', fields: [
    ['beneficiary_name', 'Beneficiary name', 'text'], ['account_number', 'Account number', 'text'],
    ['ifsc', 'IFSC', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ beneficiary_name: v.beneficiary_name, account_number: v.account_number, ifsc: v.ifsc.toUpperCase(), amount: +v.amount, mode: 'IMPS' }) },
  { key: 'bbps', label: 'BBPS (bill pay)', path: '/bbps/pay', fields: [
    ['biller_id', 'Biller ID', 'text'], ['consumer_number', 'Consumer number', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ biller_id: v.biller_id, consumer_number: v.consumer_number, amount: +v.amount }) },
  { key: 'payout', label: 'Payout', path: '/payout', fields: [
    ['beneficiary_name', 'Beneficiary name', 'text'], ['account_number', 'Account number', 'text'],
    ['ifsc', 'IFSC', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ beneficiary_name: v.beneficiary_name, account_number: v.account_number, ifsc: v.ifsc.toUpperCase(), amount: +v.amount, mode: 'IMPS' }) },
  { key: 'upi', label: 'UPI payout', path: '/upi/pay', fields: [
    ['vpa', 'UPI ID (name@bank)', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ vpa: v.vpa, amount: +v.amount }) },
  { key: 'cms', label: 'CMS (cash collection)', path: '/cms/pay', fields: [
    ['agent_id', 'Agent / company ID', 'text'], ['account_number', 'Account number', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ agent_id: v.agent_id, account_number: v.account_number, amount: +v.amount }) },
  { key: 'aeps', label: 'AEPS cash withdrawal', path: '/aeps/cash-withdrawal', fields: [
    ['aadhaar_ref', 'Aadhaar (masked ref)', 'text'], ['bank_iin', 'Bank IIN', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ aadhaar_ref: v.aadhaar_ref, bank_iin: v.bank_iin, amount: +v.amount }) },
  { key: 'matm', label: 'Micro ATM', path: '/matm/withdrawal', fields: [['amount', 'Amount', 'number']],
    build: v => ({ amount: +v.amount }) },
  { key: 'aadhaar_pay', label: 'Aadhaar Pay', path: '/aadhaar-pay', fields: [
    ['aadhaar_ref', 'Aadhaar (masked ref)', 'text'], ['bank_iin', 'Bank IIN', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ aadhaar_ref: v.aadhaar_ref, bank_iin: v.bank_iin, amount: +v.amount }) },
  { key: 'pan_card', label: 'PAN Card', path: '/pan-card/apply', fields: [
    ['applicant_name', 'Applicant name', 'text'], ['amount', 'Fee', 'number'] ],
    build: v => ({ applicant_name: v.applicant_name, amount: +v.amount }) },
  { key: 'card_swipe', label: 'Card Swipe', path: '/card-swipe', fields: [['amount', 'Amount', 'number']],
    build: v => ({ amount: +v.amount, card_type: 'debit' }) },
  { key: 'wallet_transfer', label: 'Wallet transfer (to member)', path: '/wallet-transfer', fields: [
    ['to', 'To (phone / email / username)', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ to: v.to, amount: +v.amount }) },
  { key: 'travel', label: 'Travel booking', path: '/travel/book', fields: [
    ['booking_type', 'Type (flight/bus/train/hotel)', 'text'], ['operator', 'Operator', 'text'],
    ['from_location', 'From', 'text'], ['to_location', 'To', 'text'],
    ['passenger_name', 'Passenger', 'text'], ['amount', 'Amount', 'number'] ],
    build: v => ({ booking_type: v.booking_type || 'flight', operator: v.operator, from_location: v.from_location,
      to_location: v.to_location, passenger_name: v.passenger_name, amount: +v.amount }) },
  { key: 'insurance', label: 'Insurance', path: '/insurance/buy', fields: [
    ['category', 'Category (motor/health/life/travel)', 'text'], ['insurer', 'Insurer', 'text'],
    ['customer_name', 'Customer', 'text'], ['amount', 'Premium', 'number'] ],
    build: v => ({ category: v.category || 'health', insurer: v.insurer, customer_name: v.customer_name, amount: +v.amount }) },
];

// ---------------- Actions (buttons/forms) ----------------
const Actions = {
  svcFields() {
    const s = SERVICES.find(x => x.key === $('svc').value);
    $('svc-fields').innerHTML = s.fields.map(([n, label, type]) =>
      `<div class="field"><label>${label}</label><input name="${n}" type="${type}" ${type==='number'?'step=0.01 min=0':''} /></div>`).join('');
  },
  async submitTxn() {
    const s = SERVICES.find(x => x.key === $('svc').value);
    const v = {}; s.fields.forEach(([n]) => v[n] = document.querySelector(`#svc-fields [name="${n}"]`).value.trim());
    $('txn-result').innerHTML = '<span class="muted">Processing…</span>';
    try {
      const d = await Api.post(s.path, s.build(v));
      const t = d.transaction || d.transfer;
      $('txn-result').innerHTML = `<div class="msg ok">Done — status: <b>${esc(t.status)}</b>${t.reference ? ' · ref ' + esc(t.reference) : ''}</div>`;
      App.refreshWallet();
    } catch (err) { $('txn-result').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
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
  async proposeAdj() {
    const uid = prompt('Target user ID:'); if (!uid) return;
    const kind = prompt('Kind (credit / debit / clawback):', 'credit'); if (!kind) return;
    const amount = prompt('Amount (₹):', '100'); if (!amount) return;
    const reason = prompt('Reason:', 'adjustment'); if (!reason) return;
    try { await Api.post('/admin/adjustments', { target_user_id: uid, kind, amount: +amount, reason }); UI.toast('Proposed — needs a second officer to approve'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async decideAdj(id, decision) {
    const note = prompt(`${decision} note:`, ''); if (note === null) return;
    try { await Api.post(`/admin/adjustments/${id}/${decision}`, { note }); UI.toast(`Adjustment ${decision}d`); App.route(); }
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
    try { await Api.post(`/kyc/${id}/review`, { status }); UI.toast('KYC ' + status); App.route(); }
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
    const remarks = prompt('Approve this top-up? Optional remarks:', 'Verified');
    if (remarks === null) return;
    try { await Api.post(`/admin/topups/${id}/approve`, { remarks }); UI.toast('Approved & wallet credited'); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async rejectTopup(id) {
    const remarks = prompt('Reject this top-up? Reason:', '');
    if (remarks === null) return;
    try { await Api.post(`/admin/topups/${id}/reject`, { remarks }); UI.toast('Rejected'); App.route(); }
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
      <div class="field"><label>Service code</label><input id="r_svc" placeholder="recharge"></div>
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
  async saveRule(planId) {
    const lt = val('r_lt');
    const body = { service_code: val('r_svc'), charge_type: val('r_ct'), charge_value: +val('r_cv'),
      retailer_type: lt, retailer_value: +val('r_ret'), distributor_type: lt, distributor_value: +val('r_dist'),
      master_distributor_type: lt, master_distributor_value: +val('r_md'), admin_type: lt, admin_value: +val('r_adm') };
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
if (State.token) App.boot();
else UI.authTab(new URLSearchParams(location.search).has('signup') ? 'signup' : 'login');
