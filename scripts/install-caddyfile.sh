#!/usr/bin/env bash
# Install infra/pilot/Caddyfile on the pilot VM (ADR-0019, ADR-0029):
# back up the current one, validate, reload. If the reload fails, the
# old file goes back.
#
#   scripts/install-caddyfile.sh
#   PILOT_HOST=aptask@host scripts/install-caddyfile.sh
set -euo pipefail

HOST="${PILOT_HOST:-aptask@172.16.46.54}"
SRC="$(dirname "$0")/../infra/pilot/Caddyfile"

read -r -d '' REMOTE <<'REMOTE' || true
set -euo pipefail
NEW=$(mktemp)
cat > "$NEW"
caddy validate --config "$NEW" --adapter caddyfile >/dev/null 2>&1 || {
  caddy validate --config "$NEW" --adapter caddyfile
  rm -f "$NEW"
  exit 1
}
BAK="/etc/caddy/Caddyfile.bak-$(date -u +%Y%m%dT%H%M%SZ)"
sudo cp -p /etc/caddy/Caddyfile "$BAK"
sudo install -m 644 "$NEW" /etc/caddy/Caddyfile
rm -f "$NEW"
if sudo systemctl reload caddy; then
  echo "install-caddyfile: reloaded (previous kept at $BAK)"
else
  echo "install-caddyfile: reload failed; restoring $BAK" >&2
  sudo cp -p "$BAK" /etc/caddy/Caddyfile
  sudo systemctl reload caddy
  exit 1
fi
REMOTE

ssh -o BatchMode=yes "$HOST" "bash -c $(printf '%q' "$REMOTE")" < "$SRC"
