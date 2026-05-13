#!/usr/bin/env bash
set -euo pipefail

# sign-macos-app.sh — Sign a macOS .app bundle with entitlements
#
# Single source of truth for signing. Used by:
#   - make sign-release (via _sign-one-dmg)
#   - Can also be called standalone for re-signing
#
# Usage: scripts/sign-macos-app.sh <path-to.app> <entitlements.plist>
#
# Environment:
#   ELECTROBUN_DEVELOPER_ID  — Developer ID certificate name
#   ELECTROBUN_TEAMID        — Apple Team ID
#
# Signing order (inside-out, per Apple requirements):
#   1. Native addons (.node, .dylib, .so) in Resources/ — no entitlements
#   2. All Mach-O binaries in MacOS/ — each WITH entitlements
#   3. The .app bundle itself — WITH entitlements
#   4. Verify signature
#   5. Spot-check bun has allow-jit (prevents SIGTRAP crashes)
#
# Why individual signing matters:
#   codesign on a bundle only applies --entitlements to the main executable
#   (CFBundleExecutable = launcher). The bun binary needs allow-jit for JIT
#   compilation. Without it, macOS kills bun with SIGTRAP on launch.

APP_PATH="${1:?Usage: sign-macos-app.sh <app-path> <entitlements.plist>}"
ENTITLEMENTS="${2:?Usage: sign-macos-app.sh <app-path> <entitlements.plist>}"

# --- Validation ---
: "${ELECTROBUN_DEVELOPER_ID:?Set ELECTROBUN_DEVELOPER_ID}"
: "${ELECTROBUN_TEAMID:?Set ELECTROBUN_TEAMID}"
[ -d "$APP_PATH" ] || { echo "ERROR: $APP_PATH is not a directory"; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "ERROR: $ENTITLEMENTS not found"; exit 1; }

IDENTITY="Developer ID Application: $ELECTROBUN_DEVELOPER_ID ($ELECTROBUN_TEAMID)"
MACOS_DIR="$APP_PATH/Contents/MacOS"
RESOURCES_DIR="$APP_PATH/Contents/Resources"

sign_file() {
  local path="$1"; shift
  codesign --force --timestamp --sign "$IDENTITY" --options runtime "$@" "$path"
}

# --- 1. Native addons in Resources/ (no entitlements) ---
if [ -d "$RESOURCES_DIR" ]; then
  echo "  Signing native addons in Resources/..."
  while IFS= read -r -d '' f; do
    echo "    $(basename "$f")"
    sign_file "$f"
  done < <(find "$RESOURCES_DIR" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \) -print0 2>/dev/null)
fi

# --- 2. All Mach-O in MacOS/ — WITH entitlements ---
echo "  Signing MacOS/ binaries with entitlements..."
if [ -d "$MACOS_DIR" ]; then
  for f in "$MACOS_DIR"/*; do
    [ -f "$f" ] || continue
    file -b "$f" 2>/dev/null | grep -q "Mach-O" || continue
    echo "    $(basename "$f") (+ entitlements)"
    sign_file "$f" --entitlements "$ENTITLEMENTS"
  done
fi

# --- 3. Sign .app bundle ---
echo "  Signing .app bundle..."
sign_file "$APP_PATH" --entitlements "$ENTITLEMENTS"

# --- 4. Verify ---
echo "  Verifying signature..."
codesign --verify --deep --strict "$APP_PATH"

# --- 5. Spot-check: bun MUST have allow-jit ---
BUN_BIN="$MACOS_DIR/bun"
if [ -f "$BUN_BIN" ]; then
  ENTITLEMENTS_OUT="$(codesign -d --entitlements :- "$BUN_BIN" 2>&1 || true)"
  if echo "$ENTITLEMENTS_OUT" | grep -q "invalid entitlements blob"; then
    echo ""
    echo "FATAL: bun binary has an invalid entitlements blob."
    echo "macOS will ignore invalid entitlements, causing SIGTRAP crashes."
    echo "$ENTITLEMENTS_OUT"
    exit 1
  fi
  if ! echo "$ENTITLEMENTS_OUT" | grep -q "allow-jit"; then
    echo ""
    echo "FATAL: bun binary is missing allow-jit entitlement!"
    echo "This will cause SIGTRAP crashes at runtime."
    echo "Check that entitlements.plist contains com.apple.security.cs.allow-jit"
    exit 1
  fi
  echo "  bun: allow-jit confirmed"
fi

echo "  Signing complete."
