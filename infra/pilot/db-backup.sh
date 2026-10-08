#!/usr/bin/env bash
# Nightly database backup to S3 (ADR-0035): pg_dump, checked, encrypted
# with age to the owner's key, uploaded with curl's AWS signing. The
# server can only add backups (s3:PutObject): it can't read, list or
# delete them, and only the owner's private key opens them.
#
# Settings: /etc/cloudpunch/backup.env (scripts/install-backup.sh)
#   BACKUP_BUCKET, BACKUP_REGION, BACKUP_AGE_RECIPIENT,
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, BACKUP_DB (cloudpunch_dev)
# On failure systemd runs cloudpunch-alert@ (an email to the owner).
set -euo pipefail

: "${BACKUP_BUCKET:?}" "${BACKUP_REGION:?}" "${BACKUP_AGE_RECIPIENT:?}"
: "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
DB="${BACKUP_DB:-cloudpunch_dev}"
STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# As postgres, so every table and sequence is readable.
runuser -u postgres -- pg_dump --format=custom --no-owner "$DB" > "$WORK/db.dump"
# A dump pg_restore can't read is no backup.
pg_restore --list "$WORK/db.dump" > /dev/null
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$WORK/db.dump.age" "$WORK/db.dump"

KEY="db/cloudpunch-$STAMP.dump.age"
URL="https://$BACKUP_BUCKET.s3.$BACKUP_REGION.amazonaws.com/$KEY"
# The secret goes in a curl config on stdin, never on the command line.
code="$(printf 'user = "%s:%s"\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" |
  curl -sS --config - --aws-sigv4 "aws:amz:$BACKUP_REGION:s3" \
    -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
    --upload-file "$WORK/db.dump.age" -o "$WORK/s3.out" -w '%{http_code}' "$URL")"
if [ "$code" != 200 ]; then
  echo "db-backup: S3 answered HTTP $code for $KEY: $(head -c 500 "$WORK/s3.out")" >&2
  exit 1
fi
echo "db-backup: $KEY ($(wc -c < "$WORK/db.dump.age" | tr -d ' ') bytes)"
