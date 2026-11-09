#!/usr/bin/env bash
set -euo pipefail

# create-macos-dmg.sh — Build the installer DMG with a drag-to-Applications layout
#
# Used by `make dmg` and `make sign-release` (via _sign-one-dmg). Signing,
# notarizing and stapling the DMG stay in the Makefile.
#
# Usage: scripts/create-macos-dmg.sh <staging-dir> <dmg-out>
#
#   <staging-dir>  holds exactly one signed .app (any name). This script
#                  renames it to "KeepKey Vault.app" and adds the
#                  Applications symlink.
#   <dmg-out>      path of the compressed (UDZO) DMG to write.
#
# Window layout: the app on the left, the Applications link on the right.
# Finder stores the layout in the volume's .DS_Store, which we have Finder
# write through AppleScript on a read-write image before compressing it.
# The first run from a new terminal app asks for permission to control
# Finder (System Settings > Privacy & Security > Automation).
#
# Renaming the bundle folder does not touch its code signature, and the
# Electrobun updater swaps updates in at the running bundle's own path, so
# an installed "KeepKey Vault.app" keeps its name across auto-updates.

STAGING="${1:?Usage: create-macos-dmg.sh <staging-dir> <dmg-out>}"
DMG_OUT="${2:?Usage: create-macos-dmg.sh <staging-dir> <dmg-out>}"

VOLNAME="KeepKey Vault"
APP_NAME="KeepKey Vault.app"

# Window geometry (points). Icons are positioned by their centre.
WIN_X=200; WIN_Y=120; WIN_W=540; WIN_H=360
ICON_SIZE=128
APP_POS="140, 170"
APPS_POS="400, 170"

APPS=()
while IFS= read -r -d '' a; do APPS+=("$a"); done \
	< <(find "$STAGING" -maxdepth 1 -name '*.app' -type d -print0)
if [ "${#APPS[@]}" -ne 1 ]; then
	echo "ERROR: expected exactly one .app in $STAGING, found ${#APPS[@]}" >&2
	exit 1
fi
if [ "$(basename "${APPS[0]}")" != "$APP_NAME" ]; then
	mv "${APPS[0]}" "$STAGING/$APP_NAME"
fi
[ -L "$STAGING/Applications" ] || ln -s /Applications "$STAGING/Applications"

WORK=$(mktemp -d)
DEVICE=""
cleanup() {
	if [ -n "$DEVICE" ]; then hdiutil detach "$DEVICE" -force >/dev/null 2>&1 || true; fi
	rm -rf "$WORK"
}
trap cleanup EXIT

# Finder addresses disks by name, so lay the image out under a unique name
# (a mounted copy of an earlier KeepKey Vault DMG would otherwise be the one
# Finder edits) and rename the volume once the layout is saved. The layout
# lives in the root .DS_Store and does not depend on the volume name.
BUILD_VOLNAME="KeepKey Vault build $$"
RW_DMG="$WORK/rw.dmg"
hdiutil create -volname "$BUILD_VOLNAME" -srcfolder "$STAGING" -fs HFS+ \
	-format UDRW -ov "$RW_DMG" >/dev/null

MOUNT="$WORK/mnt"
mkdir -p "$MOUNT"
ATTACH_OUT=$(hdiutil attach "$RW_DMG" -readwrite -noverify -noautoopen -mountpoint "$MOUNT")
DEVICE=$(echo "$ATTACH_OUT" | awk '/^\/dev\// {print $1; exit}')
[ -n "$DEVICE" ] || { echo "ERROR: could not attach $RW_DMG" >&2; exit 1; }
VOLDEV=$(echo "$ATTACH_OUT" | awk -v m="$MOUNT" 'index($0, m) {print $1; exit}')
[ -n "$VOLDEV" ] || { echo "ERROR: could not find the mounted volume" >&2; exit 1; }

echo "  Setting DMG window layout..."
# $MOUNT comes from mktemp, so it is safe to interpolate into the script.
osascript <<EOF
tell application "Finder"
	set vol to (POSIX file "$MOUNT" as alias)
	open vol
	delay 1
	set w to container window of vol
	set current view of w to icon view
	set toolbar visible of w to false
	set statusbar visible of w to false
	set bounds of w to {$WIN_X, $WIN_Y, $((WIN_X + WIN_W)), $((WIN_Y + WIN_H))}
	set opts to icon view options of w
	set arrangement of opts to not arranged
	set icon size of opts to $ICON_SIZE
	set text size of opts to 13
	set position of item "$APP_NAME" of vol to {$APP_POS}
	set position of item "Applications" of vol to {$APPS_POS}
	update vol without registering applications
	delay 1
	close w
end tell
EOF

# Finder writes .DS_Store asynchronously; wait for it before detaching.
for _ in $(seq 1 20); do
	[ -f "$MOUNT/.DS_Store" ] && break
	sleep 0.5
done
[ -f "$MOUNT/.DS_Store" ] || { echo "ERROR: Finder did not write .DS_Store" >&2; exit 1; }
sync
diskutil rename "$VOLDEV" "$VOLNAME" >/dev/null

hdiutil detach "$DEVICE" >/dev/null || hdiutil detach "$DEVICE" -force >/dev/null
DEVICE=""

rm -f "$DMG_OUT"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_OUT" >/dev/null
echo "  DMG created: $DMG_OUT"
