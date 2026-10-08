#!/usr/bin/env bash
# Restore a backup from db-backup.sh (ADR-0035), on the server, as root:
#
#   sudo bash /opt/cloudpunch/app/infra/pilot/db-restore.sh FILE.dump.age
#       a check: restores into a scratch database, compares row counts
#       with the live one, then drops the scratch database
#   sudo bash .../db-restore.sh FILE.dump.age --into cloudpunch_dev
#       a real restore, into an empty database of that name (a rebuilt
#       server); refuses one that has tables
#
# Asks for the owner's age private key (AGE-SECRET-KEY-…, from the
# password manager); it's kept in memory-backed /dev/shm and removed.
set -euo pipefail

FILE="${1:?usage: db-restore.sh FILE.dump.age [--into DBNAME]}"
INTO=cloudpunch_restore_check
CHECK=1
if [ "${2:-}" = --into ]; then
  INTO="${3:?--into needs a database name}"
  CHECK=0
fi
LIVE="${BACKUP_DB:-cloudpunch_dev}"
[ -f "$FILE" ] || { echo "db-restore: no file $FILE" >&2; exit 1; }
[[ "$INTO" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "db-restore: bad database name $INTO" >&2; exit 1; }

KEYFILE="$(mktemp /dev/shm/cp-age.XXXXXX)"
WORK="$(mktemp -d)"
chmod 600 "$KEYFILE"
trap 'rm -f "$KEYFILE"; rm -rf "$WORK"' EXIT
read -r -s -p "Paste the backup private key (AGE-SECRET-KEY-…): " key < /dev/tty
echo
printf '%s\n' "$key" > "$KEYFILE"
unset key
age --decrypt --identity "$KEYFILE" --output "$WORK/db.dump" "$FILE"
chmod 644 "$WORK/db.dump"
chmod 755 "$WORK"

psql_pg() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 -Atq "$@"; }
if psql_pg -d postgres -c "select 1 from pg_database where datname = '$INTO'" | grep -q 1; then
  if [ "$CHECK" = 1 ]; then
    psql_pg -d postgres -c "drop database $INTO"
  elif [ "$(psql_pg -d "$INTO" -c "select count(*) from pg_tables where schemaname = 'public'")" != 0 ]; then
    echo "db-restore: $INTO already has tables; restore into an empty database" >&2
    exit 1
  fi
fi
psql_pg -d postgres -c "select 1 from pg_database where datname = '$INTO'" | grep -q 1 ||
  psql_pg -d postgres -c "create database $INTO"
runuser -u postgres -- pg_restore --no-owner --exit-on-error -d "$INTO" "$WORK/db.dump"
echo "db-restore: restored into $INTO"

if [ "$CHECK" = 1 ]; then
  echo "Rows per table (backup / live now):"
  for t in employee app_user device time_session time_event time_correction audit_log; do
    b="$(psql_pg -d "$INTO" -c "select count(*) from $t")"
    l="$(psql_pg -d "$LIVE" -c "select count(*) from $t")"
    printf '  %-18s %8s / %s\n' "$t" "$b" "$l"
  done
  psql_pg -d postgres -c "drop database $INTO"
  echo "db-restore: check done; the scratch database is gone. Live can be a little ahead of the backup."
else
  echo "db-restore: point POSTGRES_APP_URL at $INTO if needed, then: systemctl restart cloudpunch-api"
fi
