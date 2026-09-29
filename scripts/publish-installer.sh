#!/usr/bin/env bash
# Publish the built pilot installer on https://cloudpunch.aptask.com
# (ADR-0019 §9): the landing page's Download button then serves it, with
# its notes under "What's new".
#
#   scripts/publish-installer.sh "Idle popup after 2 minutes" "Clock-in popup at 8 am ET"
#
# Checks before anything is uploaded:
#   - the installer for the version in tauri.conf.json exists;
#   - the app inside it points at the public address (not a dev build);
#   - that version isn't already published with a different file
#     (every update needs a new version number);
#   - the installer is signed for auto-update (`<file>.sig`, ADR-0022).
# Then it copies the file to the VM and adds the release to
# releases.json in one step. The newest 3 installers are kept.
set -euo pipefail

HOST="${PILOT_HOST:-aptask@172.16.46.54}"
PUBLIC_URL="https://cloudpunch.aptask.com"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ "$#" -eq 0 ]; then
  echo "publish-installer: give at least one \"what's new\" note" >&2
  exit 1
fi

VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
FILE="CloudPunch_${VERSION}_x64-setup.exe"
INSTALLER="target/release/bundle/nsis/$FILE"
[ -f "$INSTALLER" ] || { echo "publish-installer: $INSTALLER not found; build it first (docs/ops/pilot-vm.md)" >&2; exit 1; }
if ! grep -qa "$PUBLIC_URL" target/release/cloudpunch-desktop.exe; then
  echo "publish-installer: the built app doesn't point at $PUBLIC_URL; rebuild with CLOUDPUNCH_BACKEND_URL=$PUBLIC_URL" >&2
  exit 1
fi

if [ ! -f "$INSTALLER.sig" ] || [ "$INSTALLER" -nt "$INSTALLER.sig" ]; then
  echo "publish-installer: $INSTALLER isn't signed for auto-update; build with TAURI_SIGNING_PRIVATE_KEY_PATH and _PASSWORD set (docs/ops/pilot-vm.md)" >&2
  exit 1
fi
SIG="$(tr -d '\r\n' < "$INSTALLER.sig")"

SHA="$(sha256sum "$INSTALLER" | cut -c1-64)"
SIZE="$(wc -c < "$INSTALLER" | tr -d ' ')"
NOTES_JSON="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@")"
echo "publish-installer: $FILE ($SIZE bytes, sha256 $SHA)"

scp -q -o BatchMode=yes "$INSTALLER" "$HOST:/tmp/$FILE"

read -r -d '' REMOTE <<'REMOTE' || true
set -euo pipefail
DIR=/opt/cloudpunch/downloads/windows
sudo install -d -m 0755 -o root -g root /opt/cloudpunch/downloads "$DIR"
got="$(sha256sum "/tmp/$FILE" | cut -c1-64)"
[ "$got" = "$SHA" ] || { echo "publish-installer: upload corrupted" >&2; exit 1; }
sudo python3 - "$DIR" "$FILE" "$VERSION" "$SHA" "$SIZE" "$NOTES_JSON" "$SIG" <<'PY'
import json, os, sys, datetime
d, file, version, sha, size, notes, sig = sys.argv[1:8]
path = os.path.join(d, "releases.json")
try:
    releases = json.load(open(path))
except FileNotFoundError:
    releases = []
for r in releases:
    if r["version"] == version and r["sha256"] != sha:
        sys.exit(f"publish-installer: {version} is already published with a different file; bump the version")
releases = [r for r in releases if r["version"] != version]
releases.insert(0, {
    "version": version, "file": file, "size": int(size), "sha256": sha,
    "published_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "notes": json.loads(notes),
    "signature": sig,
})
releases = releases[:10]
tmp = path + ".tmp"
json.dump(releases, open(tmp, "w"), indent=2)
os.chmod(tmp, 0o644)
print("\n".join(r["file"] for r in releases[:3]), file=open(os.path.join(d, ".keep"), "w"))
PY
sudo install -m 0644 -o root -g root "/tmp/$FILE" "$DIR/$FILE.new" && sudo mv "$DIR/$FILE.new" "$DIR/$FILE"
sudo mv "$DIR/releases.json.tmp" "$DIR/releases.json"
rm -f "/tmp/$FILE"
# Keep the newest three installers.
for f in "$DIR"/*.exe; do
  grep -qx "$(basename "$f")" "$DIR/.keep" || sudo rm -f "$f"
done
echo "publish-installer: $VERSION is live"
REMOTE

ssh -o BatchMode=yes "$HOST" \
  "FILE=$(printf '%q' "$FILE") VERSION=$(printf '%q' "$VERSION") SHA=$SHA SIZE=$SIZE NOTES_JSON=$(printf '%q' "$NOTES_JSON") SIG=$(printf '%q' "$SIG") bash -c $(printf '%q' "$REMOTE")"
