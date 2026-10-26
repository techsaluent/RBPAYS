# TutiPays — Reselling API & White-Label Architecture

How the portal resells many providers' services through **one** API with a
margin, and the staged plan to turn it into a full multi-tenant white-label
platform.

---

## 1. The model you asked for (already built)

```
  Upstream providers            TutiPays core                 Your partners
  (AeronPay, Eko, Razorpay…) ─▶ one wallet + ledger + ─▶  ONE API key (pk_live_…)
  attached per service          commission engine           → all services
```

**Attach others' APIs** — Admin → Provider Connections. One connection (one
credential set) fans out to the services it powers (payout, DMT, recharge,
BBPS, AEPS…). The active provider per service is what the runtime routes to,
with auto-failover across backups.

**Resell through one API** — `/api/v1/partner/*`. A partner holds a single
`pk_live_…` key and calls every service through it (recharge, payout, DMT,
BBPS, UPI, AEPS, …) — scoped per key, rate-limited, idempotent, with signed
outbound webhooks.

**Margin (your profit)** — the commission engine:
- Each partner is on a **commission plan** (per service, and optionally per
  provider — `commission_rules.provider_id`).
- On every transaction the engine computes: what the partner earns (their
  plan), what their upline earns, and the remainder is booked to the
  **`platform_margin`** ledger account — that's your markup.
- So: *provider gives/charges you X → you pass the partner their commission →
  you keep the rest as margin.* Set per partner, per service, per provider.

**Wallet** — every partner has a prepaid wallet.
- A debit-flow service (recharge, payout, DMT…) debits `amount + charge −
  partner_commission` at request time; if the provider later fails, it's
  auto-reversed in full.
- A credit-flow service (AEPS cash-out…) credits the net into the settlement
  wallet on success.
- Controls: top-up fund-requests (maker-checker), usage up to available
  balance, **lien/hold**, **freeze**, and **chargeback recovery up the
  chain** — all admin-driven.

**Net:** a partner uses *all* services of your portal through a single API,
pays from a prepaid wallet, and you earn a configurable margin on each txn.
This is live today; the rest of this doc is the white-label layer on top.

---

## 2. Full multi-tenant white-label — staged plan

Goal: each partner runs on **their own brand** (name, logo, colours, domain),
with their own marketing site + panel, while all transactions clear through
your single core. Build in stages so each ships and earns independently.

### Stage 1 — Tenant & branding foundation
- `tenants` table: id, owner_user_id, brand_name, logo_url, colors, support
  email/phone, legal entity, status.
- Tag the hierarchy: every member/API key belongs to a `tenant_id` (a partner
  = a tenant; their sub-network inherits it).
- Branding resolver: the panel + receipts + emails + API docs read the
  caller's tenant branding instead of the hard-coded TutiPays brand.
- Admin screen to create/approve tenants and set their branding + margin plan.

### Stage 2 — Custom domains
- `tenant_domains` table (domain, tenant_id, verified, ssl_status).
- Domain verification (DNS TXT) + automated TLS (Caddy/Nginx + ACME, or a CDN).
- Request host → tenant resolution middleware: `shop.partnerbrand.com` serves
  that tenant's branded marketing site + panel from the same core.

### Stage 3 — Branded marketing site + panel per tenant
- The existing marketing pages + panel become theme-driven (CSS variables +
  logo/text from the tenant). No code fork per partner.
- Per-tenant content toggles (which services show) reuse the existing
  front-end visibility system.

### Stage 4 — Tenant isolation & admin
- Data scoping: every query filtered by tenant where applicable; a tenant
  admin sees only their network. Super-admin sees all tenants.
- Per-tenant: wallet funding, commission/margin plans, API keys, reports,
  settlement, KYC policy.
- Tenant-level audit + rate limits + webhook secrets.

### Stage 5 — Billing & settlement to partners
- Per-tenant margin statements, invoices, and payout of their earnings.
- Optional: let a tenant set *their* sub-partners' margins (multi-level
  white-label).

**Dependencies:** Stage 2 needs infra for domains/TLS (ops decision). Stages
1, 3, 4, 5 are application work on this codebase. Recommend shipping Stage 1
first — it delivers co-branded panels/receipts immediately and is the base
every later stage builds on.

---

## 3. What's ready now vs. to build

| Capability | Status |
|---|---|
| Attach providers (one credential → many services) | ✅ built |
| Single reselling API (all services, scoped keys) | ✅ built |
| Margin via commission plans (per service/provider) | ✅ built |
| Prepaid wallet + holds/freeze/chargeback | ✅ built |
| Signed outbound webhooks + monitor | ✅ built |
| API docs + code samples (cURL/Node/PHP/Python) | ✅ built |
| Per-partner **branding** (name/logo/colours) | ▶ Stage 1 |
| **Custom domains** per partner | ▶ Stage 2 |
| Branded marketing site + panel per tenant | ▶ Stage 3 |
| Tenant isolation + tenant-admin | ▶ Stage 4 |
| Partner billing / margin statements | ▶ Stage 5 |
