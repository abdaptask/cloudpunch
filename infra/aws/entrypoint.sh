#!/usr/bin/env bash
# CloudPunch container entrypoint (ADR-0045).
#
#   api                 the API (default)
#   migrate             apply migrations (POSTGRES_URL = the migrator role)
#   purge-connections   ADR-0029 §6: delete connection rows over 30 days old
#   dbip-update         refresh the DB-IP ASN database on the shared volume
#
# ECS injects secrets as environment variables. The Graph certificate key
# arrives as ENTRA_OBO_CERT_KEY_PEM and is written to a file only this
# user can read, because the API reads it from a path (ADR-0020).
set -euo pipefail

if [ -n "${ENTRA_OBO_CERT_KEY_PEM:-}" ]; then
  umask 077
  printf '%s\n' "$ENTRA_OBO_CERT_KEY_PEM" > /run/cloudpunch/entra-obo.key
  export ENTRA_OBO_CERT_KEY_PATH=/run/cloudpunch/entra-obo.key
  unset ENTRA_OBO_CERT_KEY_PEM
fi

case "${1:-api}" in
  api)
    mkdir -p /data/downloads /data/geo
    export APP_VERSION="${APP_VERSION:-$(cat /app/REVISION 2>/dev/null || echo unknown)}"
    cd /app/apps/backend
    exec node --enable-source-maps --import tsx src/server.ts
    ;;
  migrate)
    cd /app/apps/backend
    exec node --import tsx scripts/migrate.ts
    ;;
  purge-connections)
    # Same statement as infra/pilot/connections-purge.sh.
    exec psql "$POSTGRES_URL" -XAtq -v ON_ERROR_STOP=1 -c "
      WITH gone AS (
        DELETE FROM device_connection
        WHERE last_seen_at < now() - interval '30 days'
        RETURNING 1
      )
      SELECT 'connections-purge: deleted ' || count(*) || ' rows' FROM gone;"
    ;;
  dbip-update)
    exec bash /app/infra/pilot/dbip-update.sh
    ;;
  bootstrap-roles)
    # Once, before the first restore (docs/ops/aws-cutover.md, B4): the
    # pilot's two roles, with the passwords in the two URL secrets.
    # Connects with POSTGRES_ADMIN_URL (the RDS master).
    pw() { node -e 'console.log(decodeURIComponent(new URL(process.env[process.argv[1]]).password))' "$1"; }
    exec psql "$POSTGRES_ADMIN_URL" -X -v ON_ERROR_STOP=1 \
      -v migrator_pw="$(pw POSTGRES_URL)" -v app_pw="$(pw POSTGRES_APP_URL)" <<'SQL'
CREATE ROLE cloudpunch_migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE cloudpunch_app LOGIN PASSWORD :'app_pw';
GRANT CONNECT, CREATE ON DATABASE cloudpunch TO cloudpunch_migrator;
GRANT CONNECT ON DATABASE cloudpunch TO cloudpunch_app;
ALTER SCHEMA public OWNER TO cloudpunch_migrator;
GRANT USAGE ON SCHEMA public TO cloudpunch_app;
SELECT 'bootstrap-roles: done';
SQL
    ;;
  restore)
    # The cutover's copy (docs/ops/aws-cutover.md, C3): the pilot's
    # pg_dump, fetched from a short-lived S3 link, restored as the
    # migrator so it owns everything, as on the pilot.
    : "${DUMP_URL:?restore needs DUMP_URL}"
    curl -fsS --max-time 600 -o /tmp/cloudpunch.dump "$DUMP_URL"
    pg_restore --no-owner --exit-on-error --single-transaction \
      -d "$POSTGRES_URL" /tmp/cloudpunch.dump
    exec psql "$POSTGRES_URL" -XAt -c "SELECT 'restore: ' || count(*) || ' time events' FROM time_event"
    ;;
  *)
    exec "$@"
    ;;
esac
