#!/usr/bin/env bash
# Install ADR-0029's two jobs on the pilot VM, from the deployed app:
#   cloudpunch-dbip-update       monthly: DB-IP ASN Lite (provider names)
#   cloudpunch-connections-purge nightly: delete history over 30 days old
#
#   scripts/deploy-pilot.sh                # first, so the VM has the files
#   scripts/install-connection-jobs.sh
#   PILOT_HOST=aptask@host scripts/install-connection-jobs.sh
#
# Runs both jobs once and shows when they run next. Safe to repeat.
set -euo pipefail

HOST="${PILOT_HOST:-aptask@172.16.46.54}"

read -r -d '' REMOTE <<'REMOTE' || true
set -euo pipefail
SRC=/opt/cloudpunch/app/infra/pilot
if [ ! -f "$SRC/dbip-update.sh" ]; then
  echo "install-connection-jobs: $SRC is missing; run scripts/deploy-pilot.sh first" >&2
  exit 1
fi
sudo mkdir -p /opt/cloudpunch/geo
sudo install -m 644 "$SRC"/systemd/cloudpunch-*.service "$SRC"/systemd/cloudpunch-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start cloudpunch-dbip-update.service
sudo systemctl start cloudpunch-connections-purge.service
sudo systemctl enable --now cloudpunch-dbip-update.timer cloudpunch-connections-purge.timer >/dev/null
sudo journalctl -u cloudpunch-dbip-update -u cloudpunch-connections-purge --since '-5min' --no-pager -o cat |
  grep -E '^(dbip-update|connections-purge):' || true
systemctl list-timers --no-pager 'cloudpunch-*'
REMOTE

ssh -o BatchMode=yes "$HOST" "bash -c $(printf '%q' "$REMOTE")"
