#!/usr/bin/env bash
# ADR-0029 §6: delete connection history over 30 days old. Runs as the
# migrator role (the table's owner); the API's role has no DELETE.
#
# Run by cloudpunch-connections-purge.timer as the postgres OS user.
set -euo pipefail

DB="${CLOUDPUNCH_DB:-cloudpunch_dev}"
psql -d "$DB" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE cloudpunch_migrator;
WITH gone AS (
  DELETE FROM device_connection
  WHERE last_seen_at < now() - interval '30 days'
  RETURNING 1
)
SELECT 'connections-purge: deleted ' || count(*) || ' rows' FROM gone;
SQL
