#!/usr/bin/env bash
# Fetch this month's DB-IP "IP to ASN Lite" file (ADR-0029 §3) and swap
# it in. Free, CC BY 4.0, no account. The API notices the new file by
# itself (maxmind's file watch), so nothing restarts.
#
# Run by cloudpunch-dbip-update.timer; safe to run by hand any time.
set -euo pipefail

DEST="${DBIP_ASN_MMDB:-/opt/cloudpunch/geo/dbip-asn-lite.mmdb}"
DIR="$(dirname "$DEST")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DIR"

# Early in the month the new file may not be out yet: fall back a month.
for month in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m)"; do
  url="https://download.db-ip.com/free/dbip-asn-lite-${month}.mmdb.gz"
  if curl -fsS --max-time 300 -o "$TMP/asn.mmdb.gz" "$url"; then
    gunzip -f "$TMP/asn.mmdb.gz"
    # A real file is several MB and ends with MaxMind's metadata marker.
    size=$(stat -c %s "$TMP/asn.mmdb")
    if [ "$size" -lt 1000000 ] || ! grep -aq 'MaxMind.com' "$TMP/asn.mmdb"; then
      echo "dbip-update: $url is not a valid database ($size bytes)" >&2
      exit 1
    fi
    chmod 644 "$TMP/asn.mmdb"
    mv -f "$TMP/asn.mmdb" "$DEST.new"
    mv -f "$DEST.new" "$DEST"
    echo "dbip-update: installed $month ($size bytes) at $DEST"
    exit 0
  fi
done
echo "dbip-update: no file for this month or last; keeping the current one" >&2
exit 1
