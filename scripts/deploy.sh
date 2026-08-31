#!/usr/bin/env bash
#
# TutiPays production deploy — pull, migrate, build, restart, publish the panel,
# and verify health. Safe to re-run; it stops on the first error and prints a
# clear message. Run it ON THE VPS from the app directory (or set APP_DIR).
#
#   sudo -u <app-user> bash scripts/deploy.sh
#
# Override any path with an environment variable if your layout differs:
#   APP_DIR      app checkout           (default /opt/rbpays-api)
#   WEB_DIR      panel web root          (default /home/tutipays/htdocs/tutipays.com)
#   SERVICE      systemd unit            (default rbpays-api)
#   BRANCH       git branch to deploy    (default main)
#   PORT         API port for health     (default 8080)
#   HEALTH_PATH  health endpoint         (default /health)
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rbpays-api}"
WEB_DIR="${WEB_DIR:-/home/tutipays/htdocs/tutipays.com}"
SERVICE="${SERVICE:-rbpays-api}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-8080}"
HEALTH_PATH="${HEALTH_PATH:-/health}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mDEPLOY FAILED: %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$APP_DIR/.git" ] || die "APP_DIR ($APP_DIR) is not a git checkout. Set APP_DIR."
cd "$APP_DIR"

say "1/7  Fetching latest code ($BRANCH)"
git fetch --all --prune
# Record the current commit so a bad deploy can be rolled back by hand.
PREV="$(git rev-parse HEAD)"
echo "    current commit: $PREV"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH" || die "git pull was not a fast-forward — resolve manually."
echo "    new commit:     $(git rev-parse HEAD)"

say "2/7  Installing dependencies (npm ci)"
npm ci --no-audit --no-fund

say "3/7  Applying database migrations"
npm run migrate

say "4/7  Building TypeScript"
npm run build

say "5/7  Restarting the API service ($SERVICE)"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart "$SERVICE" || die "systemctl restart $SERVICE failed."
else
  echo "    systemctl not found — restart the process manager yourself."
fi

say "6/7  Publishing the web panel to $WEB_DIR"
if [ -d "$WEB_DIR" ]; then
  # Copy the panel; the ?v= cache-busting in index.html handles browser caches.
  cp -r "$APP_DIR"/web/* "$WEB_DIR"/
  echo "    panel published."
else
  echo "    WEB_DIR ($WEB_DIR) not found — skipping panel publish. Set WEB_DIR."
fi

say "7/7  Health check"
sleep 2
ok=0
for i in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:${PORT}${HEALTH_PATH}" >/dev/null 2>&1; then ok=1; break; fi
  echo "    waiting for API to come up ($i/5)…"; sleep 2
done
[ "$ok" = 1 ] || die "API did not answer ${HEALTH_PATH} on :${PORT}. Check: sudo journalctl -u $SERVICE -n 50"

say "Deploy complete ✅  (rollback: cd $APP_DIR && git reset --hard $PREV && npm ci && npm run build && sudo systemctl restart $SERVICE)"
