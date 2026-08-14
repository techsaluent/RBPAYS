# TutiPays web (single domain, path-based)

Everything on **one domain** (`tutipays.com`), no subdomains, no CORS:

| URL | Served by |
| --- | --- |
| `tutipays.com/` | Landing page (`web/index.html`) |
| `tutipays.com/panel/` | Panel — login + dashboard (`web/panel/index.html` + `panel/app.js`) |
| `tutipays.com/api/…` | The API app (Nginx proxies `/api` → `127.0.0.1:8090`) |

The panel calls the API at **`location.origin + '/api/v1'`** — same origin, so no
CORS is involved. Override with `?api=` or `window.RBPAYS_API` if needed.

## Files
```
web/
  index.html          # landing (links to panel/ and panel/?signup=1)
  panel/
    index.html        # panel shell (login + dashboard)
    app.js            # panel logic (API base = same origin /api/v1)
```

## Deploy on one CloudPanel Static Site

1. **Cloudflare** (tutipays.com) → add `A` records `@` and `www` → your VPS IP,
   proxied 🟠. SSL/TLS → **Full (strict)**. (No `api`/`panel` subdomains needed.)
2. **CloudPanel → Add Site → Create a Static Site** → `tutipays.com`
   (add `www.tutipays.com` too). Import a `tutipays.com` + `*.tutipays.com`
   Cloudflare Origin cert under SSL/TLS.
3. **Add the API proxy to the site's vhost.** CloudPanel → the site → **Vhost**
   (edit) → add this inside the `server { … }` block, above `location / { … }`:
   ```nginx
   location /api/ {
       proxy_pass http://127.0.0.1:8090;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```
   Save (CloudPanel reloads Nginx). Now `tutipays.com/api/v1/…` reaches the app;
   everything else is served as static files.
4. **Publish the files** into the site web root:
   ```bash
   SRC=/home/rbpays-api/htdocs/api.rbpays.in/app/web
   DEST=$(ls -d /home/*/htdocs/tutipays.com)
   mkdir -p "$DEST/panel"
   cp "$SRC/index.html" "$DEST/"
   cp "$SRC/panel/index.html" "$SRC/panel/app.js" "$DEST/panel/"
   chown -R "$(stat -c '%U' "$DEST")": "$DEST/index.html" "$DEST/panel"
   ```
5. Open **https://tutipays.com** → Login / Sign Up → dashboard.
   Webhook URL becomes `https://tutipays.com/api/v1/webhooks/razorpay`.

> The API app still runs under PM2 on `127.0.0.1:8090` — unchanged. This site
> just serves the static files and proxies `/api` to it, so `CORS_ORIGINS` is no
> longer required (same origin), though leaving it set does no harm.

## Local preview
```bash
cd web && python3 -m http.server 8777
# landing: http://localhost:8777/
# panel:   http://localhost:8777/panel/?api=https://tutipays.com/api/v1
```
