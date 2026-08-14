# RBPAYS API — `api.rbpays.in`

Backend API for the RBPAYS fintech platform. Provides user **signup/login** and
core modules for **DMT** (Domestic Money Transfer), **BBPS** (Bharat Bill
Payment System — Fastag, insurance, LPG, electricity, credit-card, loan, …),
**Recharge**, **Payout**, **AEPS** (Aadhaar Enabled Payment System), **CMS**
(Cash Management Services), **Card Swipe** (mPOS), **UPI** payout, **Micro ATM**,
**Aadhaar Pay**, **PAN Card**, **Wallet-to-Wallet transfer**, and **Payment
Gateway** collection — all settled against a per-user **wallet** with an
append-only ledger.

- **Stack:** Node.js + TypeScript + Express
- **Database:** self-hosted PostgreSQL on your VPS
- **Auth:** JWT access tokens + rotating refresh tokens (bcrypt password hashing)
- **Money:** stored as `BIGINT` paise (minor units) — never floats

Each service call goes through a **provider layer**: funds are reserved on the
wallet, the external provider is called, and the result is **settled** back onto
the transaction — crediting the wallet again automatically if the provider
fails. Async provider callbacks are handled by signed **webhooks**. Providers
default to a built-in **sandbox** so the whole API runs with zero external
credentials; switch to real providers (Razorpay/RazorpayX, an aggregator switch)
via `PROVIDER_*` env vars.

It also models a full **distribution hierarchy** — `admin > master_distributor >
distributor > retailer > user` — with an **admin dashboard**, **KYC** review,
per-member **service activation**, configurable **commission plans**, and an
engine that **distributes commission up the chain** on every successful
transaction. Retailers are **net-charged** (debited the amount minus their own
commission); every transaction lands in a **unified ledger** with a **printable
receipt**, and requests are **idempotent** to prevent double transactions.

---

## Quick start (local)

```bash
cp .env.example .env      # then edit secrets & DATABASE_URL
npm install
npm run migrate           # apply db/migrations to your Postgres
npm run seed:admin        # create the first admin + default commission plan
npm run dev                # start with hot reload (http://localhost:8080)
```

Health checks: `GET /health` (liveness) and `GET /ready` (verifies DB).

## Project layout

```
db/
  migrations/001_init.sql   # schema (users, wallets, ledger, all txn tables)
  index.ts                  # pg pool + withTransaction() helper
  migrate.ts                # forward-only migration runner
src/
  config/                   # env (fail-fast) + logger
  middleware/               # auth (JWT), validate (zod), error handler
  utils/                    # jwt, password, money (paise), reference, ApiError
  modules/
    auth/                   # signup, login, refresh, logout, me
    wallet/                 # balance + ledger; debit()/credit()/reverse()
    beneficiaries/          # saved bank beneficiaries (DMT & payout)
    _shared/transaction.ts  # orchestrator: idempotency + net debit + settle
    _shared/settle.ts       # apply provider result; reverse + upline credits
    transactions/           # unified ledger, list/get, printable receipt
    webhooks/               # signed async callbacks (razorpay, aggregator)
    dmt/  bbps/  recharge/  payout/  payment-gateway/
    aeps/  cms/  card-swipe/  # AEPS (credit), CMS (debit), Card Swipe (credit)
    upi/  matm/  aadhaar-pay/  pan-card/  wallet-transfer/
  providers/generic          # shared provider for the simpler services
    kyc/                    # document submission + admin review
    members/                # shared onboarding + downline queries
    network/                # retailer/distributor/MD panel + onboarding
    commission/             # commission engine + earnings
    admin/                  # dashboard, users, services, commission plans
  providers/                # provider abstraction + adapters
    types.ts                #   interfaces + result types
    sandbox.ts              #   default no-credentials provider
    razorpay.ts             #   gateway (orders + signature) + RazorpayX payout
    aggregator.ts           #   Paysprint/EKO-style DMT/BBPS/recharge switch
    index.ts                #   registry: getDmtProvider(), ...
  routes.ts                 # mounts every module under /api/v1
  app.ts  index.ts          # express app + server bootstrap
```

## Environment variables

See [`.env.example`](./.env.example). Key ones:

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string to your VPS DB |
| `PGSSLMODE` | `require` if your VPS enforces SSL, else `disable` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | generate with `openssl rand -hex 64` |
| `CORS_ORIGINS` | comma-separated allowed origins, or `*` |
| `PORT` | HTTP port (default 8080) |

---

## API reference

Base path: **`/api/v1`**. All money fields in requests are in **rupees**
(e.g. `500` or `199.50`); responses expose both `*_paise` (integer) and a
formatted rupee string where relevant.

### Auth — `/auth`

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| POST | `/signup` | – | `full_name, email, phone, password` |
| POST | `/login` | – | `identifier` (email or phone), `password` |
| POST | `/refresh` | – | `refresh_token` |
| POST | `/logout` | – | `refresh_token` |
| GET | `/me` | Bearer | – |

Signup/login return `{ user, access_token, token_type, expires_in, refresh_token }`.
Send the access token as `Authorization: Bearer <token>` on protected routes.
Refresh tokens are **rotated** on every `/refresh` (old one is revoked).

### Wallet — `/wallet`

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Current balance |
| GET | `/ledger?limit=&offset=` | Paginated credit/debit history |

### Beneficiaries — `/beneficiaries`

`POST /` (create), `GET /` (list), `DELETE /:id`.

### DMT — `/dmt`

- `POST /` — transfer money. Debits wallet by `amount + charge` atomically.
  Body: `beneficiary_name, account_number, ifsc, amount, mode(IMPS|NEFT|RTGS), charge?, reference?`
- `GET /?status=&limit=&offset=` — list; `GET /:id` — fetch one.

### BBPS — `/bbps`

- `POST /pay` — pay a bill. Body: `biller_id, consumer_number, amount, category?, biller_name?, charge?, reference?`
- `GET /`, `GET /:id`.

### Recharge — `/recharge`

- `POST /` — Body: `operator, number, amount, recharge_type(prepaid|postpaid|dth), circle?, charge?, reference?`
- `GET /`, `GET /:id`.

### Payout — `/payout`

- `POST /` — Body: `beneficiary_name, account_number, ifsc, amount, mode(IMPS|NEFT|RTGS|UPI), charge?, reference?`
- `GET /`, `GET /:id`.

### Payment Gateway — `/payment-gateway`

- `POST /orders` — create a collection order at the gateway. Body: `amount,
  gateway(razorpay|cashfree|payu), purpose?`. Returns the order plus a `checkout`
  object (key id, order id) for the client SDK.
- `POST /orders/:id/confirm` — confirm payment. Body: `gateway_payment_id,
  signature`. The **gateway signature is verified** (`HMAC-SHA256`); only on a
  valid signature is the order marked `success` and, for `wallet_topup`, the
  wallet credited. An invalid signature returns `400` and marks the order failed.
- `GET /orders`, `GET /orders/:id`.

### Webhooks — `/webhooks` (no auth; HMAC-signed)

Mounted with a raw body parser so signatures verify against the exact bytes.
Events are recorded in `provider_events` and de-duplicated (idempotent replays
return `{"status":"duplicate"}`).

- `POST /razorpay` — header `X-Razorpay-Signature`. Handles `payment.captured` /
  `order.paid` (credits a wallet-topup order) and `payout.processed|failed|reversed`
  (settles the payout, reversing the wallet on failure).
- `POST /aggregator` — header `X-Webhook-Signature = HMAC-SHA256(rawBody,
  AGGREGATOR_WEBHOOK_SECRET)`. Body `{ reference, service, status, provider_ref?,
  utr?, message? }` settles the matching DMT/BBPS/recharge/payout transaction.

### AEPS — `/aeps` (credit / earning)

Aadhaar Enabled Payments. A **credit** service: on success the retailer's wallet
is credited the settled amount **plus** their commission.

- `POST /cash-withdrawal` — `{ aadhaar_ref, bank_iin, amount, bank_name?, mobile? }`.
  Wallet credited `amount + commission`.
- `POST /balance-enquiry`, `POST /mini-statement` — `{ aadhaar_ref, bank_iin }`.
  Amount 0; earns the configured (usually flat) commission; balance enquiry returns
  the customer's bank `balance_paise`.
- `GET /`, `GET /:id`. (`aadhaar_ref` is a masked reference — never send full biometric.)

### CMS — `/cms` (debit / earning)

Cash Management Services / collection. A **debit** service like BBPS: the retailer
is net-debited (`amount − commission`) and earns commission.

- `POST /pay` — `{ agent_id, account_number, amount, biller_name?, customer_name?, charge? }`.
- `GET /`, `GET /:id`.

### Card Swipe — `/card-swipe` (credit / MDR charged)

mPOS card collection. A **credit** service where the retailer is **charged the
MDR**: on success the wallet is credited `amount − MDR`.

- `POST /` — `{ amount, card_network?, card_type?, card_last4?, tid? }`.
- `GET /`, `GET /:id`.

### UPI — `/upi` (debit)

- `POST /pay` — payout to a VPA. `{ vpa, amount, payee_name?, charge? }`.
- `GET /`, `GET /:id`.

### Micro ATM — `/matm` (credit)

- `POST /withdrawal` — card cash withdrawal. `{ amount, card_network?, card_last4? }`.
  Wallet credited `amount + commission`. `GET /`, `GET /:id`.

### Aadhaar Pay — `/aadhaar-pay` (credit)

- `POST /` — merchant collection via Aadhaar. `{ aadhaar_ref, bank_iin, amount, mobile? }`.
  Wallet credited `amount − charge` (+ commission). `GET /`, `GET /:id`.

### PAN Card — `/pan-card` (debit)

- `POST /apply` — NSDL/UTI application. `{ applicant_name, amount, application_type?, portal?, pan_number?, charge? }`.
  `GET /`, `GET /:id`.

### Wallet transfer — `/wallet-transfer` (P2P)

- `POST /` — transfer to another member. `{ to (phone or email), amount, charge?, note? }`.
  Debits the sender `amount + charge`, credits the receiver `amount`, atomically.
  Idempotent on `reference` / `Idempotency-Key`. `GET /` lists sent + received.

### BBPS billers — `/bbps/billers`, `/bbps/categories`

Discover billers for Fastag, insurance, LPG, electricity, gas, water, broadband,
DTH, credit-card, loan, municipal and education, then pay via `POST /bbps/pay`.

### Transactions — `/transactions`

A single ledger across every service (`transactions` table), one row per
transaction with `amount / charge / commission / net`.

- `GET /?service=&status=&direction=&limit=&offset=` — my history (admins may
  pass `user_id` to view any member).
- `GET /:id` — one transaction.
- `GET /:id/receipt` — **printable HTML receipt** (thermal-printer friendly, with
  a Print button). Add `?format=json` for structured receipt data.

**Idempotency (avoid double transactions).** Every debit service accepts a
`reference` (body) or an **`Idempotency-Key`** header. Re-submitting the same key
returns the **original** transaction (`200`, `idempotent: true`) instead of
charging again; the unique `reference` also protects against concurrent
double-clicks.

### KYC — `/kyc`

- `POST /` — submit a document. Body: `doc_type(aadhaar|pan|gst|shop_photo|
  bank_proof|selfie|other), doc_number?, file_url?`.
- `GET /` — my documents + my overall `kyc_status`.
- `GET /pending` *(admin)* — all pending documents.
- `POST /:id/review` *(admin)* — `{ status: verified|rejected, remarks? }`;
  recomputes the owner's `kyc_status`.

### Network / panels — `/network` (retailer, distributor, master distributor)

- `GET /panel` — wallet, downline counts, and earnings summary for the caller.
- `POST /members` — onboard a downline member (rank-checked: you may only create
  a strictly lower role). Body: `full_name, email, phone, password, role`.
- `GET /members?role=` — direct downline. `GET /downline` — full tree.
- `GET /earnings` — my distributed commission ledger + total.

### Admin — `/admin` (admin only)

- `GET /dashboard` — user counts by role, wallet float, per-service volumes,
  pending KYC, total commission paid.
- **Users:** `GET /users?role=&status=&q=`, `GET /users/:id` (with wallet +
  services), `POST /users` (onboard any member role), `PATCH /users/:id/status`
  (`active|suspended|blocked`), `PATCH /users/:id/plan` (assign commission plan),
  `POST /users/:id/services` (`{ service_code, active, apply_activation_fee? }`).
- **Services:** `GET /services`, `PATCH /services/:code` (`{ enabled?,
  activation_charge? }` in rupees).
- **Commission plans:** `GET /commission-plans`, `POST /commission-plans`,
  `GET /commission-plans/:id` (with rules), `POST /commission-plans/:id/rules`,
  `DELETE /commission-plans/:id/rules/:ruleId`.

Create the first admin with `npm run seed:admin` (reads `ADMIN_*` env).

### Error shape

```json
{ "error": { "code": "unprocessable", "message": "Insufficient wallet balance", "details": {…} } }
```

---

## Design notes

- **Atomic money moves.** Every debit/credit runs inside a single Postgres
  transaction (`withTransaction`) and locks the wallet row (`SELECT … FOR
  UPDATE`) so concurrent spends can't oversell the balance. Each movement writes
  a `wallet_transactions` ledger row with the running `balance_after`.
- **Integer paise.** All amounts are integer minor units to avoid floating-point
  drift. `src/utils/money.ts` converts to/from rupees at the edges.
- **Idempotency handle.** Every service transaction carries a unique `reference`
  (client-supplied or auto-generated `RB-<MODULE>-<hex>`).
- **Token security.** Refresh tokens are opaque random strings; only their
  SHA-256 hash is stored, so a DB leak can't be replayed.
- **Provider settlement.** Each service creates a `pending` txn + wallet debit
  atomically, then calls the provider. The result is settled: `success` finalizes
  it, `failed` marks it failed **and reverses the wallet exactly once** (guarded
  by `reversed_at`), `pending` waits for a webhook. Same-outcome webhook + poll
  collapse safely — terminal rows are never re-settled.

## Providers

Selected per module via `PROVIDER_*` env vars; unknown values fall back to
sandbox.

| Module | `sandbox` (default) | Real adapter |
| --- | --- | --- |
| DMT / BBPS / Recharge | deterministic outcomes | `aggregator` — configurable Paysprint/EKO-style switch |
| Payout | deterministic outcomes | `razorpay` — RazorpayX (contact → fund account → payout) |
| Payment Gateway | sha256 test signature | `razorpay` — Orders API + real HMAC signature/webhook verification |

**Sandbox test hooks** (drive outcomes by amount, for testing): **₹13** → failed
(triggers reversal), **₹7** → pending (settle later via webhook), anything else →
success.

To plug in a real aggregator, set `PROVIDER_DMT=aggregator` (etc.) and the
`AGGREGATOR_*` vars; adjust endpoint paths / response mapping in
`src/providers/aggregator.ts` to match your vendor's API. For Razorpay set
`PROVIDER_GATEWAY=razorpay` / `PROVIDER_PAYOUT=razorpay` and the `RAZORPAY_*`
vars.

## Distribution hierarchy & commission

Roles form a chain: **admin → master_distributor → distributor → retailer →
user**. Each member has a `parent_id` (who onboarded them) and a
`commission_plan_id`. A member may only onboard a strictly lower role.

A **commission plan** holds **slab rules** per service and amount range. Each rule
sets the customer `charge` and the commission each level earns, as `flat` (rupees)
or `percent` (of the transaction amount).

**Two money flows.** Services are either **debit** (retailer pays) or **credit**
(retailer receives), and the retailer is always netted against their own
commission and any charge:

| Flow | Services | Wallet effect on success |
| --- | --- | --- |
| **debit** | DMT, BBPS, Recharge, Payout, CMS, UPI, PAN Card | `net_debit = amount + charge − retailer_commission` |
| **credit** | AEPS, Card Swipe, Micro ATM, Aadhaar Pay | `net_credit = amount + retailer_commission − charge` |

- **DMT** charges the retailer a fee (`charge > 0`) — standard debit.
- **CMS** earns commission — the retailer is debited `amount − commission`.
- **AEPS** earns commission — the wallet is credited `amount + commission`.
- **Card Swipe** is charged the **MDR** (`charge > 0`) — credited `amount − MDR`.

**Net commission (retailer is netted).** The breakdown is computed *before* any
money moves, so a ₹100 recharge at 2% retailer commission debits ₹98 in a single
ledger entry (not ₹100 then a ₹2 credit). On **success**, the **upline** wallets are
credited from platform margin, up the ancestor chain (for credit-flow services the
retailer is also credited the settlement amount):

- **retailer** level → the performer — realised as the reduced debit (recorded for
  earnings, not credited again)
- **distributor** / **master_distributor** → nearest ancestor of that role → wallet credit
- **admin** → nearest admin ancestor (else global admin) → wallet credit

Every level is written to `commission_entries` (unique per `txn + level`, so
distribution is idempotent). On **failure**, the **net** amount is reversed
exactly once. Members see earnings at `GET /network/earnings`.

**Service gating.** Every transaction route is guarded by `requireService`: the
account must be `active`, the service globally `enabled`, and — if the member has
a `user_services` row — that row `active`. Admins toggle these and can charge a
per-service activation fee.

---

## Deploying to your VPS

1. **PostgreSQL** (Ubuntu example):
   ```bash
   sudo apt install postgresql
   sudo -u postgres psql -c "CREATE ROLE rbpays LOGIN PASSWORD 'strong-pass';"
   sudo -u postgres psql -c "CREATE DATABASE rbpays OWNER rbpays;"
   ```
2. **App:**
   ```bash
   git clone <repo> && cd rbpays-api
   cp .env.example .env         # set DATABASE_URL + JWT secrets
   npm ci
   npm run build
   npm run migrate
   npm start                    # or run under a process manager
   ```
3. **Keep it running** with systemd or pm2, e.g. a systemd unit running
   `node dist/index.js` with `EnvironmentFile=/path/.env`.
4. **Reverse proxy** `api.rbpays.in` → `127.0.0.1:8080` with Nginx/Caddy and
   terminate TLS there (the app already sets `trust proxy`).

## Scripts

| Script | Action |
| --- | --- |
| `npm run dev` | hot-reload dev server |
| `npm run build` | compile TypeScript to `dist/` |
| `npm start` | run compiled server |
| `npm run migrate` | apply pending migrations |
| `npm run migrate:status` | list applied/pending migrations |
| `npm run seed:admin` | create the first admin + default commission plan (`ADMIN_*` env) |
| `npm run typecheck` | type-check without emit |
