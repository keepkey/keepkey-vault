#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <downloaded-certified-artifact-dir>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/projects/keepkey-vault/emulator-bundle/manifest.json"
INPUT_DIR="$(cd "$1" && pwd)"
BUNDLE_DIR="$ROOT/projects/keepkey-vault/emulator-bundle"

MAC_ARCHIVE="$(node -p "require('$MANIFEST').source.macArchive")"
MAC_LIBRARY_PATH="$(node -p "require('$MANIFEST').source.macLibraryPath")"
WINDOWS_LIBRARY="$(node -p "require('$MANIFEST').source.windowsLibrary")"

test -f "$INPUT_DIR/$MAC_ARCHIVE" || { echo "missing certified archive: $INPUT_DIR/$MAC_ARCHIVE" >&2; exit 1; }
test -f "$INPUT_DIR/$WINDOWS_LIBRARY" || { echo "missing certified DLL: $INPUT_DIR/$WINDOWS_LIBRARY" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar --zstd -xf "$INPUT_DIR/$MAC_ARCHIVE" -C "$WORK"
test -f "$WORK/$MAC_LIBRARY_PATH" || { echo "missing certified dylib in archive: $MAC_LIBRARY_PATH" >&2; exit 1; }

cp "$WORK/$MAC_LIBRARY_PATH" "$BUNDLE_DIR/libkkemu.dylib"
cp "$INPUT_DIR/$WINDOWS_LIBRARY" "$BUNDLE_DIR/libkkemu.dll"
node "$ROOT/scripts/verify-certified-emulator.mjs"
