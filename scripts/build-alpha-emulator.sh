#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/keepkey-alpha-emulator.XXXXXX")"
export EMU_ALPHA_SOURCE_RECEIPT="$WORK/alpha-source.json"
export EMU_FIRMWARE_SOURCE_DIR="$WORK/firmware"
node "$ROOT/scripts/alpha-emulator-source.mjs" "$EMU_FIRMWARE_SOURCE_DIR" "$EMU_ALPHA_SOURCE_RECEIPT"
export EMU_FIRMWARE_SHA="$(node -p "require(process.argv[1]).commit" "$EMU_ALPHA_SOURCE_RECEIPT")"
# Local builds stay outside the certified bundle until their CI artifact is
# qualified and imported. CI supplies its disposable checkout's staging path.
export EMU_STAGE_DIR="${EMU_STAGE_DIR:-$WORK/libraries}"
mkdir -p "$EMU_STAGE_DIR"
bash "$ROOT/scripts/build-emulator-macos-release.sh"
bash "$ROOT/scripts/build-emulator-windows.sh"
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'EMU_FIRMWARE_SHA=%s\nEMU_ALPHA_SOURCE_RECEIPT=%s\n' "$EMU_FIRMWARE_SHA" "$EMU_ALPHA_SOURCE_RECEIPT" >> "$GITHUB_ENV"
fi
echo "Built both alpha emulator libraries at $EMU_STAGE_DIR from $EMU_FIRMWARE_SHA"
