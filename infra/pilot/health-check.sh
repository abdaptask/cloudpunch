#!/usr/bin/env bash
# Every minute (ADR-0035, ADR-0043): is the API answering on the server,
# is the site answering from the internet side (through the Cloudflare
# Tunnel), is the database, and is the disk under 90%?
#
# A problem must fail two checks in a row before anyone hears (a blip
# isn't worth a message). Then one email to ALERT_TO and one post to the
# Teams channel (TEAMS_ALERT_WEBHOOK_URL) when it starts, and one of
# each when it's fixed, nothing in between.
set -uo pipefail

STATE=/var/lib/cloudpunch-health
mkdir -p "$STATE"
NOTIFY=(/usr/local/bin/node --import tsx /opt/cloudpunch/app/apps/backend/scripts/notify.ts)
PUBLIC_URL="${PUBLIC_SITE_URL:-https://cloudpunch.aptask.com}"
cd /opt/cloudpunch/app/apps/backend || exit 1

check() {
  local name="$1" problem="$2"
  local key="${name// /-}"
  if [ -n "$problem" ]; then
    local fails=$(( $(cat "$STATE/$key.fails" 2>/dev/null || echo 0) + 1 ))
    echo "$fails" > "$STATE/$key.fails"
    echo "health-check: $name: $problem (failed $fails in a row)" >&2
    if [ "$fails" -ge 2 ] && [ ! -f "$STATE/$key" ]; then
      echo "$problem" > "$STATE/$key"
      "${NOTIFY[@]}" "Problem: $name" "$problem

Checked on $(hostname) at $(date -u '+%Y-%m-%d %H:%M UTC'), two checks in a row a minute apart. You'll get one more message when it's fixed.
Runbook: docs/ops/pilot-vm.md, \"Backups and alerts\"." || true
    fi
  else
    rm -f "$STATE/$key.fails"
    if [ -f "$STATE/$key" ]; then
      rm -f "$STATE/$key"
      "${NOTIFY[@]}" "Fixed: $name" "$name is fine again ($(date -u '+%Y-%m-%d %H:%M UTC'))." || true
    fi
  fi
}

api=""
curl -fsS --max-time 10 -o /dev/null http://127.0.0.1:8080/readyz 2>/dev/null ||
  api="The API isn't answering on the server (http://127.0.0.1:8080/readyz). Check: systemctl status cloudpunch-api"
check "api" "$api"

# Only worth saying when the API itself is fine: then it's Caddy or the tunnel.
site=""
if [ -z "$api" ]; then
  curl -fsS --max-time 15 -o /dev/null "$PUBLIC_URL/readyz" 2>/dev/null ||
    site="$PUBLIC_URL isn't answering from the internet side, though the API is up: likely the Cloudflare Tunnel. Check: systemctl status cloudflared"
fi
check "site" "$site"

db=""
runuser -u postgres -- psql -d "${BACKUP_DB:-cloudpunch_dev}" -Atqc 'select 1' >/dev/null 2>&1 ||
  db="The database isn't answering. Check: systemctl status postgresql"
check "database" "$db"

used="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
disk=""
[ "${used:-0}" -lt 90 ] || disk="The disk is ${used}% full."
check "disk space" "$disk"
exit 0
