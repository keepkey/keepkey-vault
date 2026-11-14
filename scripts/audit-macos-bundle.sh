#!/usr/bin/env bash
set -euo pipefail

# Release gate for a fully assembled macOS application. Run this before signing
# and again after signing. It deliberately audits the whole bundle rather than
# a short allow-list: native dependencies and helper tools are executable code.

APP_PATH="${1:?Usage: audit-macos-bundle.sh <app-path> <arm64|x86_64> [maximum-min-macos]}"
EXPECTED_ARCH="${2:?Usage: audit-macos-bundle.sh <app-path> <arm64|x86_64> [maximum-min-macos]}"
MAX_MIN_MACOS="${3:-13.0}"

case "$EXPECTED_ARCH" in
  arm64|x86_64) ;;
  *) echo "ERROR: expected architecture must be arm64 or x86_64"; exit 2 ;;
esac

[ -d "$APP_PATH" ] || { echo "ERROR: app bundle not found: $APP_PATH"; exit 2; }
command -v file >/dev/null || { echo "ERROR: file is required"; exit 2; }
command -v lipo >/dev/null || { echo "ERROR: lipo is required"; exit 2; }
command -v otool >/dev/null || { echo "ERROR: otool is required"; exit 2; }

version_gt() {
  awk -v left="$1" -v right="$2" 'BEGIN {
    split(left, a, "."); split(right, b, ".")
    for (i = 1; i <= 3; i++) {
      av = (a[i] == "" ? 0 : a[i]) + 0
      bv = (b[i] == "" ? 0 : b[i]) + 0
      if (av > bv) exit 0
      if (av < bv) exit 1
    }
    exit 1
  }'
}

fail=0
count=0
echo "Auditing macOS bundle: $APP_PATH"
echo "  required architecture: $EXPECTED_ARCH"
echo "  maximum deployment target: $MAX_MIN_MACOS"

while IFS= read -r -d '' candidate; do
  file -b "$candidate" 2>/dev/null | grep -q 'Mach-O' || continue
  relative="${candidate#"$APP_PATH"/}"

  # node-hid intentionally carries both Darwin prebuilds so an arm64-built
  # staging app can be converted to x64. Audit only the runtime selected for
  # this artifact; the required directory is checked explicitly below.
  case "$EXPECTED_ARCH:$relative" in
    x86_64:*'/node-hid/prebuilds/HID-darwin-arm64/'*) continue ;;
    arm64:*'/node-hid/prebuilds/HID-darwin-x64/'*) continue ;;
  esac

  count=$((count + 1))
  arches="$(lipo -archs "$candidate" 2>/dev/null || true)"
  if ! echo " $arches " | grep -q " $EXPECTED_ARCH "; then
    echo "ERROR: $relative has architectures [$arches], missing $EXPECTED_ARCH"
    fail=1
  fi

  # Support both modern LC_BUILD_VERSION and older LC_VERSION_MIN_MACOSX.
  minos_values="$(otool -l "$candidate" 2>/dev/null | awk '
    $1 == "cmd" { command = $2 }
    (command == "LC_BUILD_VERSION" && $1 == "minos") ||
    (command == "LC_VERSION_MIN_MACOSX" && $1 == "version") { print $2 }
  ')"
  if [ -z "$minos_values" ]; then
    echo "ERROR: $relative has no readable LC_BUILD_VERSION minimum OS"
    fail=1
  else
    while IFS= read -r minos; do
      [ -n "$minos" ] || continue
      if version_gt "$minos" "$MAX_MIN_MACOS"; then
        echo "ERROR: $relative requires macOS $minos (release ceiling is $MAX_MIN_MACOS)"
        fail=1
      fi
    done <<EOF
$minos_values
EOF
  fi
done < <(
  # Executable code lives in MacOS and Frameworks. Resources holds native addons
  # and libraries plus extensionless executables (the Electrobun 2.x update
  # manager Resources/uninstall, zcash-cli, Monero helpers); any of those must be
  # executable to run, so audit every executable file there as well. This avoids
  # running `file` over every JS/JSON asset.
  [ ! -d "$APP_PATH/Contents/MacOS" ] || find "$APP_PATH/Contents/MacOS" -type f -print0
  [ ! -d "$APP_PATH/Contents/Frameworks" ] || find "$APP_PATH/Contents/Frameworks" -type f -print0
  [ ! -d "$APP_PATH/Contents/Resources" ] || find "$APP_PATH/Contents/Resources" -type f \
    \( -name '*.node' -o -name '*.dylib' -o -name '*.so' -o -perm -u+x \) -print0
)

if [ "$count" -eq 0 ]; then
  echo "ERROR: no Mach-O files found in bundle"
  fail=1
fi

HID_ROOT="$APP_PATH/Contents/Resources/app/node_modules/node-hid/prebuilds"
HID_ARCH="$EXPECTED_ARCH"
[ "$HID_ARCH" != "x86_64" ] || HID_ARCH="x64"
HID_DIR="$HID_ROOT/HID-darwin-$HID_ARCH"
if [ ! -d "$HID_DIR" ]; then
  echo "ERROR: required node-hid prebuild directory is missing: ${HID_DIR#"$APP_PATH"/}"
  fail=1
elif ! find "$HID_DIR" -type f -name '*.node' -print -quit | grep -q .; then
  echo "ERROR: node-hid prebuild directory contains no .node addon: ${HID_DIR#"$APP_PATH"/}"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "Bundle audit FAILED ($count Mach-O files inspected). Do not sign or publish this artifact."
  exit 1
fi

echo "Bundle audit passed ($count Mach-O files inspected)."
