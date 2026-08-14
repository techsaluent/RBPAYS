# RBPAYS API — `api.rbpays.in`

Backend API for the RBPAYS fintech platform. Provides user **signup/login** and
core modules for **DMT** (Domestic Money Transfer), **BBPS** (Bharat Bill
Payment System), **Recharge**, **Payout**, and **Payment Gateway** collection —
all settled against a per-user **wallet** with an append-only ledger.

- **Stack:** Node.js + TypeScript + Express
- **Database:** self-hosted PostgreSQL on your VPS
- **Auth:** JWT access tokens + rotating refresh tokens (bcrypt password hashing)
- **Money:** stored as `BIGINT` paise (minor units) — never floats

> This is the initial skeleton: authentication, the wallet engine, and CRUD for
> every module. The service-provider integrations (actual DMT/BBPS/recharge/
> payout/gateway API calls) are left as clearly-marked stubs — transactions are
> created in `pending` state and the wallet is debited/credited atomically.

---

## Quick start (local)

```bash
cp .env.example .env      # then edit secrets & DATABASE_URL
npm install
npm run migrate           # apply db/migrations to your Postgres
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
    wallet/                 # balance + ledger; debit()/credit() engine
    beneficiaries/          # saved bank beneficiaries (DMT & payout)
    dmt/  bbps/  recharge/  payout/  payment-gateway/
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

- `POST /orders` — create a collection order. Body: `amount, gateway(razorpay|cashfree|payu), purpose?`
- `POST /orders/:id/confirm` — confirm payment; on `success` + `wallet_topup`,
  credits the wallet. Body: `gateway_payment_id, gateway_order_id?, status`.
  **In production, verify the gateway signature here before trusting `status`.**
- `GET /orders`, `GET /orders/:id`.

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
| `npm run typecheck` | type-check without emit |
