#!/usr/bin/env bash
# Every 5 minutes (ADR-0035): is the API answering, is the database, and
# is the disk under 90%? Emails the owner when something goes wrong and
# again when it's fixed, not every 5 minutes in between.
set -uo pipefail

STATE=/var/lib/cloudpunch-health
mkdir -p "$STATE"
NOTIFY=(/usr/local/bin/node --import tsx /opt/cloudpunch/app/apps/backend/scripts/notify.ts)
cd /opt/cloudpunch/app/apps/backend || exit 1

check() {
  local name="$1" problem="$2"
  if [ -n "$problem" ]; then
    if [ ! -f "$STATE/$name" ]; then
      echo "$problem" > "$STATE/$name"
      "${NOTIFY[@]}" "Problem: $name" "$problem

Checked on $(hostname) at $(date -u '+%Y-%m-%d %H:%M UTC'). You'll get one more email when it's fixed.
Runbook: docs/ops/pilot-vm.md, \"Backups and alerts\"." || true
    fi
    echo "health-check: $name: $problem" >&2
  elif [ -f "$STATE/$name" ]; then
    rm -f "$STATE/$name"
    "${NOTIFY[@]}" "Fixed: $name" "$name is fine again ($(date -u '+%Y-%m-%d %H:%M UTC'))." || true
  fi
}

api=""
curl -fsS --max-time 10 -o /dev/null http://127.0.0.1:8080/livez 2>/dev/null ||
  api="The API isn't answering (http://127.0.0.1:8080/livez). Check: systemctl status cloudpunch-api"
check "api" "$api"

db=""
runuser -u postgres -- psql -d "${BACKUP_DB:-cloudpunch_dev}" -Atqc 'select 1' >/dev/null 2>&1 ||
  db="The database isn't answering. Check: systemctl status postgresql"
check "database" "$db"

used="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
disk=""
[ "${used:-0}" -lt 90 ] || disk="The disk is ${used}% full."
check "disk space" "$disk"
exit 0
