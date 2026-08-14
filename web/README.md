# RBPAYS Panel (web)

A zero-build, static web panel for the RBPAYS API — **login/signup**, an
**admin dashboard** (users, KYC, commissions, services) and a **partner portal**
(wallet, run any service, transactions + receipts, downline, earnings). It is
plain HTML + CSS + vanilla JS (`index.html` + `app.js`) that calls the API over
HTTPS, so it can be hosted on any static site — including a **CloudPanel static
site** on your VPS.

## What it points at

`app.js` picks the API base automatically:
- on `localhost` → `http://localhost:8080/api/v1`
- anywhere else → `https://api.rbpays.in/api/v1`

Override without editing code by adding `?api=` to the URL, or set
`window.RBPAYS_API` before `app.js` loads.

## Deploy it as `panel.rbpays.in` (CloudPanel)

1. **Cloudflare** → add an `A` record: `panel` → your VPS IP (proxied 🟠), same as `api`.
2. **CloudPanel** → **Sites → Add Site → Create a Static Site** → domain `panel.rbpays.in`.
   Issue SSL for it (Origin cert import, or DNS-only + Let's Encrypt — same as the API).
3. **Copy these two files** into that site's web root
   (`/home/<panel-user>/htdocs/panel.rbpays.in/`):
   ```bash
   SRC=/home/rbpays-api/htdocs/api.rbpays.in/app/web
   DEST=$(ls -d /home/*/htdocs/panel.rbpays.in)
   cp "$SRC/index.html" "$SRC/app.js" "$DEST/"
   chown "$(stat -c '%U' "$DEST")": "$DEST/index.html" "$DEST/app.js"
   ```
4. **Allow the panel origin in the API's CORS.** On the API server, edit the API
   `.env` and add the panel origin, then restart:
   ```ini
   CORS_ORIGINS=https://rbpays.in,https://www.rbpays.in,https://panel.rbpays.in
   ```
   ```bash
   sudo -u rbpays-api bash -lc 'cd ~/htdocs/api.rbpays.in/app && pm2 restart rbpays-api'
   ```
5. Open **https://panel.rbpays.in** and log in with your admin
   (`admin@rbpays.in`).

> Prefer to serve it from the API server instead of a separate subdomain? You can,
> but keeping the panel on its own origin (or folding it into your existing site)
> is cleaner. Wherever it lives, its origin must be in `CORS_ORIGINS`.

## Local preview

```bash
cd web && python3 -m http.server 8777
# open http://localhost:8777/?api=https://api.rbpays.in/api/v1
```
(Use the `?api=` override so the browser talks to the live API; that origin must
be allowed in the API's `CORS_ORIGINS`, e.g. add `http://localhost:8777`.)

## Notes

- **Top up (test gateway)** only works while `PROVIDER_GATEWAY=sandbox`. With real
  Razorpay, wallet top-ups go through Razorpay Checkout instead.
- This is a functional v1 covering the core flows; extend `Screens` / `SERVICES`
  in `app.js` to add more.
