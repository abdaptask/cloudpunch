#!/usr/bin/env bash
# Publish the built pilot installer on https://cloudpunch.aptask.com
# (ADR-0019 §9): the landing page's Download button then serves it, with
# its notes under "What's new".
#
#   scripts/publish-installer.sh "Idle popup after 2 minutes" "Clock-in popup at 8 am ET"
#   scripts/publish-installer.sh --mac "First Mac version"      # ADR-0026
#
# Checks before anything is uploaded:
#   - the installer for the version in tauri.conf.json exists;
#   - the app inside it points at the public address (not a dev build);
#   - that version isn't already published with a different file
#     (every update needs a new version number);
#   - the update is signed for auto-update (`.sig`, ADR-0022).
# Then it copies the files to the VM and adds the release to that
# platform's releases.json in one step. The newest 3 are kept.
#
# Windows: the NSIS .exe (also the update). macOS: the .dmg for people
# and the .app.tar.gz for the updater, from a universal build.
set -euo pipefail

HOST="${PILOT_HOST:-aptask@172.16.46.54}"
PUBLIC_URL="https://cloudpunch.aptask.com"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PLATFORM=windows
if [ "${1:-}" = "--mac" ]; then
  PLATFORM=macos
  shift
fi
if [ "$#" -eq 0 ]; then
  echo "publish-installer: give at least one \"what's new\" note" >&2
  exit 1
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi
}
size_of() { wc -c < "$1" | tr -d ' '; }
fresh_sig() {
  if [ ! -f "$1.sig" ] || [ "$1" -nt "$1.sig" ]; then
    echo "publish-installer: $1 isn't signed for auto-update; build with TAURI_SIGNING_PRIVATE_KEY (the key file path) and _PASSWORD set (docs/ops/pilot-vm.md)" >&2
    exit 1
  fi
}

VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
if [ "$PLATFORM" = windows ]; then
  FILE="CloudPunch_${VERSION}_x64-setup.exe"
  INSTALLER="target/release/bundle/nsis/$FILE"
  BINARY="target/release/cloudpunch-desktop.exe"
  UPDATE="$INSTALLER"
  UPDATE_FILE=""
else
  BUNDLE="target/universal-apple-darwin/release/bundle"
  FILE="CloudPunch_${VERSION}_universal.dmg"
  INSTALLER="$BUNDLE/dmg/$FILE"
  BINARY="target/universal-apple-darwin/release/cloudpunch-desktop"
  UPDATE="$BUNDLE/macos/CloudPunch.app.tar.gz"
  # Versioned on the server, so old and new can sit side by side.
  UPDATE_FILE="CloudPunch_${VERSION}_universal.app.tar.gz"
fi

[ -f "$INSTALLER" ] || { echo "publish-installer: $INSTALLER not found; build it first (docs/ops/pilot-vm.md)" >&2; exit 1; }
[ -f "$UPDATE" ] || { echo "publish-installer: $UPDATE not found; build with createUpdaterArtifacts" >&2; exit 1; }
if ! grep -qa "$PUBLIC_URL" "$BINARY"; then
  echo "publish-installer: the built app doesn't point at $PUBLIC_URL; rebuild with CLOUDPUNCH_BACKEND_URL=$PUBLIC_URL" >&2
  exit 1
fi
fresh_sig "$UPDATE"
SIG="$(tr -d '\r\n' < "$UPDATE.sig")"

SHA="$(sha256 "$INSTALLER")"
SIZE="$(size_of "$INSTALLER")"
UPDATE_SHA=""
UPDATE_SIZE=""
if [ -n "$UPDATE_FILE" ]; then
  UPDATE_SHA="$(sha256 "$UPDATE")"
  UPDATE_SIZE="$(size_of "$UPDATE")"
fi
NOTES_JSON="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@")"
echo "publish-installer: $PLATFORM $FILE ($SIZE bytes, sha256 $SHA)"

scp -q -o BatchMode=yes "$INSTALLER" "$HOST:/tmp/$FILE"
if [ -n "$UPDATE_FILE" ]; then
  scp -q -o BatchMode=yes "$UPDATE" "$HOST:/tmp/$UPDATE_FILE"
fi

read -r -d '' REMOTE <<'REMOTE' || true
set -euo pipefail
DIR="/opt/cloudpunch/downloads/$PLATFORM"
sudo install -d -m 0755 -o root -g root /opt/cloudpunch/downloads "$DIR"
got="$(sha256sum "/tmp/$FILE" | cut -c1-64)"
[ "$got" = "$SHA" ] || { echo "publish-installer: upload corrupted" >&2; exit 1; }
if [ -n "$UPDATE_FILE" ]; then
  got="$(sha256sum "/tmp/$UPDATE_FILE" | cut -c1-64)"
  [ "$got" = "$UPDATE_SHA" ] || { echo "publish-installer: update upload corrupted" >&2; exit 1; }
fi
sudo python3 - "$DIR" "$FILE" "$VERSION" "$SHA" "$SIZE" "$NOTES_JSON" "$SIG" "$UPDATE_FILE" "$UPDATE_SIZE" <<'PY'
import json, os, sys, datetime
d, file, version, sha, size, notes, sig, update_file, update_size = sys.argv[1:10]
path = os.path.join(d, "releases.json")
try:
    releases = json.load(open(path))
except FileNotFoundError:
    releases = []
for r in releases:
    if r["version"] == version and r["sha256"] != sha:
        sys.exit(f"publish-installer: {version} is already published with a different file; bump the version")
releases = [r for r in releases if r["version"] != version]
entry = {
    "version": version, "file": file, "size": int(size), "sha256": sha,
    "published_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "notes": json.loads(notes),
    "signature": sig,
}
if update_file:
    entry["update_file"] = update_file
    entry["update_size"] = int(update_size)
releases.insert(0, entry)
releases = releases[:10]
tmp = path + ".tmp"
json.dump(releases, open(tmp, "w"), indent=2)
os.chmod(tmp, 0o644)
keep = []
for r in releases[:3]:
    keep.append(r["file"])
    if r.get("update_file"):
        keep.append(r["update_file"])
print("\n".join(keep), file=open(os.path.join(d, ".keep"), "w"))
PY
sudo install -m 0644 -o root -g root "/tmp/$FILE" "$DIR/$FILE.new" && sudo mv "$DIR/$FILE.new" "$DIR/$FILE"
if [ -n "$UPDATE_FILE" ]; then
  sudo install -m 0644 -o root -g root "/tmp/$UPDATE_FILE" "$DIR/$UPDATE_FILE.new" && sudo mv "$DIR/$UPDATE_FILE.new" "$DIR/$UPDATE_FILE"
  rm -f "/tmp/$UPDATE_FILE"
fi
sudo mv "$DIR/releases.json.tmp" "$DIR/releases.json"
rm -f "/tmp/$FILE"
# Keep the newest three releases' files.
for f in "$DIR"/*.exe "$DIR"/*.dmg "$DIR"/*.app.tar.gz; do
  [ -e "$f" ] || continue
  grep -qx "$(basename "$f")" "$DIR/.keep" || sudo rm -f "$f"
done
echo "publish-installer: $PLATFORM $VERSION is live"
REMOTE

ssh -o BatchMode=yes "$HOST" \
  "PLATFORM=$PLATFORM FILE=$(printf '%q' "$FILE") VERSION=$(printf '%q' "$VERSION") SHA=$SHA SIZE=$SIZE NOTES_JSON=$(printf '%q' "$NOTES_JSON") SIG=$(printf '%q' "$SIG") UPDATE_FILE=$(printf '%q' "$UPDATE_FILE") UPDATE_SHA=$UPDATE_SHA UPDATE_SIZE=$UPDATE_SIZE bash -c $(printf '%q' "$REMOTE")"
