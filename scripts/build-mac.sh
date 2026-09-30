#!/usr/bin/env bash
# Build the signed, notarized Mac pilot app (ADR-0026) on the owner's Mac.
#
#   bash scripts/build-mac.sh you@aptask.com
#
# It finds the Developer ID certificate and Team ID in the keychain, asks
# for the two passwords (nothing is shown or saved), checks everything,
# then runs the universal build. Output goes under
# target/universal-apple-darwin/release/bundle/; publish it with
# scripts/publish-installer.sh --mac "…".
set -euo pipefail

fail() { echo "build-mac: $*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || fail "this is $(uname), not a Mac. Run it in the Mac's own Terminal, not over SSH to the VM."

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/desktop"

APPLE_ID="${1:-}"
if [ -z "$APPLE_ID" ]; then
  read -r -p 'Apple ID email: ' APPLE_ID
fi
case "$APPLE_ID" in
  *@*.*) ;;
  *) fail "\"$APPLE_ID\" doesn't look like an email address" ;;
esac

IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -n 1)"
[ -n "$IDENTITY" ] || fail "no Developer ID Application certificate in the keychain. Make one in Xcode → Settings → Accounts → Manage Certificates (docs/ops/pilot-vm.md step 3)."
TEAM_ID="$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"
[ -n "$TEAM_ID" ] || fail "couldn't read the Team ID from \"$IDENTITY\""

KEY="$HOME/.cloudpunch/updater.key"
[ -f "$KEY" ] || fail "no updater key at $KEY. Copy updater.key from the password manager there (docs/ops/pilot-vm.md step 5)."

command -v pnpm >/dev/null 2>&1 || fail "pnpm not found. Run: corepack enable"
command -v rustup >/dev/null 2>&1 || fail "Rust not found. Install it from https://rustup.rs"
for t in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target list --installed | grep -qx "$t" || fail "Rust target $t missing. Run: rustup target add aarch64-apple-darwin x86_64-apple-darwin"
done
[ -d "$ROOT/node_modules" ] || fail "packages not installed. Run: pnpm install (in $ROOT)"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
echo
echo "  Version:     $VERSION"
echo "  Certificate: $IDENTITY"
echo "  Team ID:     $TEAM_ID"
echo "  Apple ID:    $APPLE_ID"
echo "  Updater key: $KEY"
echo

read -r -s -p 'App-specific password (from appleid.apple.com): ' APPLE_PASSWORD; echo
[ -n "$APPLE_PASSWORD" ] || fail "empty app-specific password"
read -r -s -p 'Updater key password: ' TAURI_SIGNING_PRIVATE_KEY_PASSWORD; echo
[ -n "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ] || fail "empty updater key password"

export CLOUDPUNCH_BACKEND_URL=https://cloudpunch.aptask.com
export APPLE_SIGNING_IDENTITY="$IDENTITY" APPLE_ID APPLE_TEAM_ID="$TEAM_ID" APPLE_PASSWORD
export TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD

echo "Building $VERSION. This takes a while, then a few more minutes while Apple notarizes it."
pnpm tauri build --target universal-apple-darwin --config src-tauri/tauri.pilot.macos.conf.json

BUNDLE="$ROOT/target/universal-apple-darwin/release/bundle"
echo
echo "Done:"
ls -l "$BUNDLE/dmg/CloudPunch_${VERSION}_universal.dmg" "$BUNDLE/macos/CloudPunch.app.tar.gz" "$BUNDLE/macos/CloudPunch.app.tar.gz.sig"
echo
echo "Next: scripts/publish-installer.sh --mac \"First Mac version\""
