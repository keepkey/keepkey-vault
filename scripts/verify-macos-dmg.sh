#!/usr/bin/env bash
set -euo pipefail

# Gate before a macOS DMG is uploaded: it is notarized and stapled, Gatekeeper
# accepts it, and its app is the exact app in the update archive uploaded beside
# it (same code directory hash). The update archive is notarized only through
# this DMG (electrobun.config.ts notarize: false), so both must be one build.
#
# Usage: scripts/verify-macos-dmg.sh <dmg> <app.tar.zst>

DMG="${1:?Usage: verify-macos-dmg.sh <dmg> <app.tar.zst>}"
TAR_ZST="${2:?Usage: verify-macos-dmg.sh <dmg> <app.tar.zst>}"
test -f "$DMG" || { echo "ERROR: $DMG not found"; exit 1; }
test -f "$TAR_ZST" || { echo "ERROR: $TAR_ZST not found"; exit 1; }

xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"

WORK=$(mktemp -d)
MNT="$WORK/mnt"
mkdir "$MNT"
cleanup() {
	hdiutil detach "$MNT" -force >/dev/null 2>&1 || true
	rm -rf "$WORK/tar" "$WORK/app.tar"
	rmdir "$MNT" "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach "$DMG" -nobrowse -readonly -noautoopen -mountpoint "$MNT" >/dev/null
zstd -d -q "$TAR_ZST" -o "$WORK/app.tar"
mkdir "$WORK/tar"
tar xf "$WORK/app.tar" -C "$WORK/tar"

DMG_APP=$(find "$MNT" -maxdepth 1 -name '*.app' -type d | head -1)
TAR_APP=$(find "$WORK/tar" -maxdepth 1 -name '*.app' -type d | head -1)
test -n "$DMG_APP" || { echo "ERROR: no .app in $DMG"; exit 1; }
test -n "$TAR_APP" || { echo "ERROR: no .app in $TAR_ZST"; exit 1; }

codesign --verify --deep --strict "$DMG_APP"
cdhash() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
DMG_HASH=$(cdhash "$DMG_APP")
TAR_HASH=$(cdhash "$TAR_APP")
if [ -z "$DMG_HASH" ] || [ "$DMG_HASH" != "$TAR_HASH" ]; then
	echo "ERROR: the DMG's app (CDHash ${DMG_HASH:-none}) is not the app in $(basename "$TAR_ZST") (CDHash ${TAR_HASH:-none})"
	exit 1
fi
echo "ok: $(basename "$DMG") is stapled, accepted by Gatekeeper, and carries the app in $(basename "$TAR_ZST") (CDHash $DMG_HASH)"
