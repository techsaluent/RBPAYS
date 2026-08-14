# TutiPays web (landing + panel)

The public front end for TutiPays — a marketing **landing page** with Login /
Sign Up, plus the **partner & admin panel**. Zero build: plain HTML/CSS/JS that
calls the API over HTTPS, hostable on any static site (e.g. a CloudPanel Static
Site at **tutipays.com**).

| File | What it is |
| --- | --- |
| `index.html` | Landing page (hero, services, Login / Sign Up buttons) |
| `app.html` | The panel — login/signup screen + dashboard (admin & partner) |
| `app.js` | Shared logic; auto-targets `https://api.tutipays.com/api/v1` |

Flow: **tutipays.com** (landing) → *Login* → `app.html` → dashboard.
*Sign Up* → `app.html?signup=1` (signup tab pre-selected). Landing and panel are
the **same origin**, so the auth token is shared between them.

`app.js` picks the API base from the hostname (`*.tutipays.com` → `api.tutipays.com`,
`*.rbpays.in` → `api.rbpays.in`, `localhost` → local). Override with `?api=` or
`window.RBPAYS_API`.

## Deploy on tutipays.com (CloudPanel)

1. **Cloudflare** (tutipays.com) → add `A` records: `@`/`www` (or just the root)
   and `api`, both → your VPS IP, proxied 🟠. Also `api` for the API.
2. **CloudPanel** → **Add Site → Create a Static Site** → `tutipays.com`.
   Issue SSL (import the `*.tutipays.com` Cloudflare Origin cert).
3. Copy the three files into its web root:
   ```bash
   SRC=/home/rbpays-api/htdocs/api.rbpays.in/app/web
   DEST=$(ls -d /home/*/htdocs/tutipays.com)
   cp "$SRC/index.html" "$SRC/app.html" "$SRC/app.js" "$DEST/"
   chown "$(stat -c '%U' "$DEST")": "$DEST"/index.html "$DEST"/app.html "$DEST"/app.js
   ```
4. **Allow the origin in the API's CORS** — add `https://tutipays.com` to
   `CORS_ORIGINS` in the API `.env` and `pm2 restart rbpays-api`.
5. Open **https://tutipays.com** → Login / Sign Up → dashboard.

## Local preview

```bash
cd web && python3 -m http.server 8777
# open http://localhost:8777/?api=https://api.tutipays.com/api/v1
```

## Notes

- Sandbox "top up" works only while `PROVIDER_GATEWAY=sandbox`; with real Razorpay
  it goes through Razorpay Checkout.
- Landing copy/branding is original (TutiPays) — swap in your own logo/text freely.
