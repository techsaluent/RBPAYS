# TutiPays — Go-Live Checklist

A step-by-step guide to take TutiPays from the current build to a live,
money-moving platform on the VPS. Work top to bottom; nothing here needs code
changes — it is configuration and switch-on.

> Deploy at any point with: `sudo -u <app-user> bash scripts/deploy.sh`
> (pull → migrate → build → restart → publish panel → health check).

---

## 1. Server & runtime

- [ ] Node 20+ and PostgreSQL 16 installed and running.
- [ ] App checked out at `/opt/rbpays-api` (or set `APP_DIR` for the deploy script).
- [ ] systemd unit `rbpays-api` runs `node dist/src/index.js` with `EnvironmentFile` pointing at your `.env`.
- [ ] Nginx/Caddy reverse-proxies `api.tutipays.com` → `127.0.0.1:8080` and terminates TLS.
- [ ] Panel served from `/home/tutipays/htdocs/tutipays.com` (admin console at `/?portal=admin`, ideally mapped to `tutipays.com/admin`).

## 2. Environment (`.env`)

- [ ] `DATABASE_URL` (or `PG*`) points at the production database.
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are long, random, and secret.
- [ ] `NODE_ENV=production` (this stops OTP/reset codes being returned in responses).
- [ ] `CORS_ORIGINS` lists your real front-end origins (not `*`).
- [ ] `HOME_STATE_CODE` set (GST intra/inter-state split), TDS thresholds reviewed.
- [ ] Provider webhook secrets set where applicable (`AGGREGATOR_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET`).

## 3. Database

- [ ] `npm run migrate` applied cleanly (through the latest migration).
- [ ] `npm run seed:admin` run once (creates the first admin + default commission plan). Set strong `ADMIN_*` env first.
- [ ] Take a first backup and confirm your backup schedule.

## 4. Security (admin)

- [ ] Admin logs in only from the admin URL, and **`security_admin_ip_allowlist`** is set to your office/VPN IPs (Website settings). This is the real lock.
- [ ] Enable **authenticator 2FA** on the admin account (Security screen).
- [ ] Decide whether to require **signup OTP** and **KYC-before-transacting** (Website settings) and turn them on if wanted.
- [ ] Review the login lockout (5 fails / 15 min) — no action needed, on by default.

## 5. Commission & tax

- [ ] Review the default commission plan and any per-service rules (Commission screen).
- [ ] Confirm tax rates/caps (TDS 194H/194N, GST) under Tax (TDS/GST).
- [ ] Members submit PAN/GSTIN so the correct (5% vs 20%) 194H rate applies.

## 6. Catalog

- [ ] Review the **Operator & Biller Catalog** — enable/disable/add operators and billers to match what you actually sell.

## 7. Providers — the money rails

For each service you are launching (recharge, DMT, BBPS, payout, AEPS, …):

- [ ] Add a provider under **Providers** with the correct driver and **live** API keys/base URL.
- [ ] Click **Test** — confirm config + endpoint reachability pass.
- [ ] Give the provider its **callback URL** (shown on the provider row) so status updates settle automatically.
- [ ] **Activate** the provider. Activate a second provider (lower priority) to enable **auto-failover**.
- [ ] Confirm the **Go-live readiness** banner shows the service as **live** (not sandbox / none).

## 8. Operations

- [ ] Decide the **Auto-recon** window (Website settings, `auto_recon_hours`; 0 = off). When set, stuck pendings are auto-failed + refunded after that many hours.
- [ ] Set the **Dispute SLA** hours (Website settings).
- [ ] Turn on member **SMS notifications** (transaction / low-balance / KYC) and confirm the SMS integration is configured.
- [ ] Configure the SMS/OTP and verification (PAN/Aadhaar) integrations under **Integrations** if you want live KYC and OTP.

## 9. Smoke test on production

- [ ] Sign up a test retailer, complete KYC, add wallet balance.
- [ ] Run one small **real** transaction per live service; confirm it settles and the receipt is correct.
- [ ] Confirm the provider **callback** arrives and the transaction reaches a terminal status.
- [ ] Check **Analytics** shows the activity and **Ledger** balances.

## 10. Launch

- [ ] DNS for `tutipays.com` and `api.tutipays.com` points at the VPS; TLS valid.
- [ ] Onboard the first real distributors/retailers.
- [ ] Watch **Risk & AML**, **Disputes**, and **Reconciliation** daily for the first weeks.

---

### Quick deploy reference

```bash
# On the VPS, as the app user:
sudo -u <app-user> bash /opt/rbpays-api/scripts/deploy.sh
# or manually:
cd /opt/rbpays-api && git pull && npm ci && npm run migrate && npm run build \
  && sudo systemctl restart rbpays-api \
  && cp -r /opt/rbpays-api/web/* /home/tutipays/htdocs/tutipays.com/
```

Rollback (the deploy script prints the exact command with the previous commit):

```bash
cd /opt/rbpays-api && git reset --hard <PREV_COMMIT> && npm ci && npm run build && sudo systemctl restart rbpays-api
```
