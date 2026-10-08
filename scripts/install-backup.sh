#!/usr/bin/env bash
# One-time setup of backups and alerts on the pilot server (ADR-0035),
# from the owner's PC (Git Bash), after scripts/deploy-pilot.sh:
#
#   bash scripts/install-backup.sh
#   bash scripts/install-backup.sh --reconfigure   # new key or settings
#
# On the server it:
#   - installs `age`;
#   - asks for the S3 bucket, the backup user's access key (hidden) and
#     the alert address;
#   - makes the backup encryption key: the private half is shown once
#     for the password manager and never stored on the server;
#   - writes /etc/cloudpunch/backup.env and alert.env (root only);
#   - installs and starts the nightly backup and the 5-minute health
#     check;
#   - runs a backup now, and sends a test alert email.
# Safe to repeat: existing settings and the key are kept.
set -euo pipefail

HOST="${PILOT_HOST:-aptask@172.16.46.54}"
RECONFIGURE=0
[ "${1:-}" = --reconfigure ] && RECONFIGURE=1

read -r -d '' REMOTE <<'REMOTE' || true
set -euo pipefail
SRC=/opt/cloudpunch/app/infra/pilot
[ -f "$SRC/db-backup.sh" ] || { echo "install-backup: $SRC/db-backup.sh is missing; run scripts/deploy-pilot.sh first" >&2; exit 1; }
command -v age >/dev/null || { echo "Installing age…"; sudo apt-get install -y -qq age >/dev/null; }

if [ "$RECONFIGURE" = 1 ] || ! sudo test -f /etc/cloudpunch/backup.env; then
  read -r -p "S3 bucket [aptask-cloudpunch-backups]: " bucket
  bucket="${bucket:-aptask-cloudpunch-backups}"
  read -r -p "Access key ID of cloudpunch-backup: " key_id
  read -r -s -p "Secret access key (not shown): " secret; echo
  read -r -p "Send alerts to (email, or several with commas): " alert_to
  [ -n "$key_id" ] && [ -n "$secret" ] && [ -n "$alert_to" ] || { echo "install-backup: all three are needed" >&2; exit 1; }
  # India-only data stays in Mumbai (ADR-0001). S3 says where a bucket
  # is without any credentials.
  region="$(curl -sI "https://$bucket.s3.amazonaws.com" | tr -d '' | sed -n 's/^x-amz-bucket-region: //Ip')"
  if [ "$region" != ap-south-1 ]; then
    echo "install-backup: bucket $bucket is in ${region:-no region (does it exist?)}, not ap-south-1 (Mumbai)." >&2
    echo "  Delete it and create it again with the region menu set to Asia Pacific (Mumbai)." >&2
    exit 1
  fi

  recipient="$(sudo sed -n 's/^BACKUP_AGE_RECIPIENT=//p' /etc/cloudpunch/backup.env 2>/dev/null || true)"
  if [ -z "$recipient" ] || [ "$RECONFIGURE" = 1 ]; then
    # age-keygen won't write over an existing file, so a fresh private
    # folder in memory (not a pre-made temp file).
    keydir="$(mktemp -d /dev/shm/cp-age.XXXXXX)"
    keyfile="$keydir/key"
    age-keygen -o "$keyfile" 2>/dev/null
    recipient="$(age-keygen -y "$keyfile")"
    echo
    echo "=== The backup PRIVATE key. Save it now in the password manager as"
    echo "=== cloudpunch/backup-age-key. It is not kept on the server: without"
    echo "=== it no backup can be opened."
    echo
    grep '^AGE-SECRET-KEY-' "$keyfile"
    echo
    rm -rf "$keydir"
    while :; do
      read -r -p 'Type "saved" once it is in the password manager: ' ok
      [ "$ok" = saved ] && break
    done
    clear || true
  fi

  umask 077
  printf '%s\n' \
    "BACKUP_BUCKET=$bucket" \
    "BACKUP_REGION=ap-south-1" \
    "BACKUP_DB=cloudpunch_dev" \
    "BACKUP_AGE_RECIPIENT=$recipient" \
    "AWS_ACCESS_KEY_ID=$key_id" \
    "AWS_SECRET_ACCESS_KEY=$secret" | sudo tee /etc/cloudpunch/backup.env >/dev/null
  printf 'ALERT_TO=%s\nBACKUP_DB=cloudpunch_dev\n' "$alert_to" | sudo tee /etc/cloudpunch/alert.env >/dev/null
  sudo chmod 600 /etc/cloudpunch/backup.env /etc/cloudpunch/alert.env
  unset secret
fi

sudo install -m 644 "$SRC"/systemd/cloudpunch-db-backup.* "$SRC"/systemd/cloudpunch-health.* \
  "$SRC"/systemd/cloudpunch-alert@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudpunch-db-backup.timer cloudpunch-health.timer >/dev/null

echo "Backing up now…"
if sudo systemctl start cloudpunch-db-backup.service; then
  sudo journalctl -u cloudpunch-db-backup --since '-5min' --no-pager -o cat | grep '^db-backup:' | tail -1
else
  echo "install-backup: the backup failed:" >&2
  sudo journalctl -u cloudpunch-db-backup --since '-5min' --no-pager -o cat | tail -15 >&2
  exit 1
fi

echo "Sending a test alert…"
# The same settings files as the real jobs (systemd reads them).
TEST="This is a test. CloudPunch emails this address when a backup fails, or when the API, the database or the disk needs attention, and again when it is fixed."
sudo systemd-run --quiet --wait --pipe --collect \
  -p EnvironmentFile=/etc/cloudpunch/api.env -p EnvironmentFile=/etc/cloudpunch/alert.env \
  -p WorkingDirectory=/opt/cloudpunch/app/apps/backend \
  /usr/local/bin/node --import tsx scripts/notify.ts "Alerts are on" "$TEST"
systemctl list-timers --no-pager 'cloudpunch-*'
REMOTE

ssh -t "$HOST" "RECONFIGURE=$RECONFIGURE bash -c $(printf '%q' "$REMOTE")"
