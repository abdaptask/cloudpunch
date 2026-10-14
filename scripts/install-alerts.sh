#!/usr/bin/env bash
# Teams alerts and notices on the pilot server (ADR-0043), from the
# owner's PC (Git Bash), after scripts/deploy-pilot.sh and once
# scripts/install-backup.sh has made /etc/cloudpunch/alert.env:
#
#   bash scripts/install-alerts.sh
#
# On the server it:
#   - asks for the Teams channel webhook for alerts (hidden), and the one
#     for notices (Enter = the same channel);
#   - writes TEAMS_ALERT_WEBHOOK_URL into alert.env (the health check)
#     and api.env (the API's own alerts), and TEAMS_NOTICE_WEBHOOK_URL
#     into api.env (missed starts, corrections waiting);
#   - installs the every-minute health check and restarts the API;
#   - sends a test alert by email and to Teams.
# Safe to repeat: it replaces those lines and keeps everything else.
set -euo pipefail

HOST="${PILOT_HOST:-aptask@172.16.46.54}"

read -r -d '' REMOTE <<'REMOTE' || true
set -euo pipefail
SRC=/opt/cloudpunch/app/infra/pilot
[ -f "$SRC/health-check.sh" ] || { echo "install-alerts: $SRC is missing; run scripts/deploy-pilot.sh first" >&2; exit 1; }
sudo test -f /etc/cloudpunch/alert.env || { echo "install-alerts: no /etc/cloudpunch/alert.env; run scripts/install-backup.sh first" >&2; exit 1; }

read -r -s -p "Teams webhook URL for alerts (not shown): " alert_url; echo
read -r -s -p "Teams webhook URL for notices (Enter = the same channel): " notice_url; echo
notice_url="${notice_url:-$alert_url}"
for u in "$alert_url" "$notice_url"; do
  case "$u" in
    https://*) ;;
    *) echo "install-alerts: a webhook URL starts with https://" >&2; exit 1 ;;
  esac
done

# Replace KEY=… in a root-only env file, keeping the other lines.
put() {
  local file="$1" key="$2" value="$3"
  sudo sed -i "/^$key=/d" "$file"
  printf '%s=%s\n' "$key" "$value" | sudo tee -a "$file" >/dev/null
}
put /etc/cloudpunch/alert.env TEAMS_ALERT_WEBHOOK_URL "$alert_url"
put /etc/cloudpunch/api.env TEAMS_ALERT_WEBHOOK_URL "$alert_url"
put /etc/cloudpunch/api.env TEAMS_NOTICE_WEBHOOK_URL "$notice_url"
unset alert_url notice_url

sudo install -m 644 "$SRC"/systemd/cloudpunch-health.* "$SRC"/systemd/cloudpunch-alert@.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudpunch-health.timer >/dev/null
sudo systemctl restart cloudpunch-health.timer
sudo systemctl restart cloudpunch-api
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:8080/readyz && break
  sleep 2
done

echo "Sending a test alert…"
TEST="This is a test. CloudPunch posts here, and emails, when the API, the site, the database or the disk needs attention (checked every minute), when uploads are refused or a background job keeps failing, and again when it is fixed."
sudo systemd-run --quiet --wait --pipe --collect \
  -p EnvironmentFile=/etc/cloudpunch/api.env -p EnvironmentFile=/etc/cloudpunch/alert.env \
  -p WorkingDirectory=/opt/cloudpunch/app/apps/backend \
  /usr/local/bin/node --import tsx scripts/notify.ts "Fixed: Teams alerts are on" "$TEST"
systemctl list-timers --no-pager 'cloudpunch-health*'
REMOTE

ssh -t "$HOST" "bash -c $(printf '%q' "$REMOTE")"
