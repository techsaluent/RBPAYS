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
  if (h.endsWith('rbpays.in')) return 'https://api.rbpays.in/api/v1';
  return 'https://api.tutipays.com/api/v1'; // tutipays.com and anything else
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
const NAV = [
  { key: 'dashboard', label: 'Dashboard', roles: '*' },
  { key: 'wallet', label: 'Wallet', roles: '*' },
  { key: 'new', label: 'New Transaction', roles: '*' },
  { key: 'txns', label: 'Transactions', roles: '*' },
  { key: 'network', label: 'My Network', roles: MEMBER_ROLES },
  { key: 'members', label: 'Users', roles: ['admin'] },
  { key: 'kyc', label: 'KYC Review', roles: ['admin'] },
  { key: 'plans', label: 'Commission', roles: ['admin'] },
  { key: 'adminservices', label: 'Services', roles: ['admin'] },
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
    } else {
      const p = MEMBER_ROLES.includes(State.user.role) ? await Api.get('/network/panel').catch(() => null) : null;
      const w = await Api.get('/wallet');
      const earn = p ? p.earnings.total_paise / 100 : 0;
      const dc = p ? Object.entries(p.downline_counts || {}).map(([k, n]) => `${k}: <b>${n}</b>`).join(' &nbsp; ') : '';
      $('view').innerHTML = `
        <div class="grid cards">
          <div class="card"><div class="k">Wallet balance</div><div class="v">${money(w.wallet.balance)}</div></div>
          ${p ? `<div class="card"><div class="k">Commission earned</div><div class="v">${money(earn)}</div></div>` : ''}
        </div>
        ${p ? `<div class="panel mt"><h2>My downline</h2><div>${dc || 'No members yet'}</div></div>` : ''}
        <div class="panel mt"><h2>Quick actions</h2>
          <a class="btn sm" href="#/new">New transaction</a> &nbsp;
          <a class="btn sm ghost" href="#/wallet">Top up wallet</a></div>`;
    }
  },

  async wallet() {
    const w = await Api.get('/wallet');
    const l = await Api.get('/wallet/ledger?limit=25');
    const rows = l.items.map(r => `<tr><td>${r.direction === 'credit' ? '＋' : '－'} ${money(r.amount)}</td>
      <td>${esc(r.source)}</td><td class="muted">${esc(r.description || '')}</td>
      <td class="right">${money(r.balance_after)}</td><td class="muted">${new Date(r.created_at).toLocaleString('en-IN')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="grid cards"><div class="card"><div class="k">Balance</div><div class="v">${money(w.wallet.balance)}</div></div></div>
      <div class="panel mt"><div class="row" style="justify-content:space-between"><h2>Ledger</h2>
        <button class="btn sm" onclick="Actions.topup()">Top up (test gateway)</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>Amount</th><th>Source</th><th>Description</th><th class="right">Balance</th><th>When</th></tr></thead>
        <tbody>${rows || '<tr><td colspan=5 class=muted>No transactions yet</td></tr>'}</tbody></table></div></div>`;
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
      <td>${esc(m.role)}</td><td>${esc(m.phone)}</td><td>${UI.statusTag(m.status)}</td></tr>`).join('');
    const erows = earn.items.map(e => `<tr><td>${esc(e.service_code)}</td><td>${esc(e.level)}</td>
      <td class="right">${money(e.amount_paise/100)}</td><td class="muted">${new Date(e.created_at).toLocaleString('en-IN')}</td></tr>`).join('');
    $('view').innerHTML = `
      <div class="grid cards">
        <div class="card"><div class="k">Total earnings</div><div class="v">${money(earn.total_paise/100)}</div></div>
        <div class="card"><div class="k">Downline members</div><div class="v">${members.items.length}</div></div>
      </div>
      <div class="panel mt"><div class="row" style="justify-content:space-between"><h2>My members</h2>
        <button class="btn sm" onclick="Actions.addMember(false)">+ Add member</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Phone</th><th>Status</th></tr></thead>
        <tbody>${mrows || '<tr><td colspan=5 class=muted>No members yet</td></tr>'}</tbody></table></div></div>
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

  async kyc() {
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
    const rows = d.items.map(s => `<tr><td>${esc(s.code)}</td><td>${esc(s.name)}</td>
      <td>${s.enabled ? '<span class="tag active">on</span>' : '<span class="tag blocked">off</span>'}</td>
      <td><button class="btn sm ghost" onclick="Actions.toggleService('${s.code}',${!s.enabled})">${s.enabled ? 'Disable' : 'Enable'}</button></td></tr>`).join('');
    $('view').innerHTML = `<div class="panel"><h2>Services</h2><div class="tbl-wrap"><table>
      <thead><tr><th>Code</th><th>Name</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
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
  async reviewKyc(id, status) {
    try { await Api.post(`/kyc/${id}/review`, { status }); UI.toast('KYC ' + status); App.route(); }
    catch (err) { UI.toast(err.message, 'err'); }
  },
  async toggleService(code, enabled) {
    try { await Api.patch(`/admin/services/${code}`, { enabled }); App.route(); }
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
