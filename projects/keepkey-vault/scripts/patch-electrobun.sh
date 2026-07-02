#!/bin/bash
# Patch Electrobun's build to:
# 1. Use quiet zip mode + larger buffer (prevents ENOBUFS)
# 2. Add NSCameraUsageDescription to Info.plist (allows QR scanning permission)
EBUN_CLI="node_modules/electrobun/src/cli/index.ts"
sed_in_place() {
  local expr="$1"
  local file="$2"
  sed -i.bak "$expr" "$file" && rm -f "$file.bak"
}

if [ -f "$EBUN_CLI" ]; then
  if grep -q 'zip -y -r -q -9' "$EBUN_CLI"; then
    echo "[patch-electrobun] zip quiet mode already patched"
  elif grep -q '`zip -y -r -9' "$EBUN_CLI"; then
    sed_in_place 's/`zip -y -r -9/`zip -y -r -q -9/g' "$EBUN_CLI"
    echo "[patch-electrobun] Patched zip quiet mode"
  else
    echo "[patch-electrobun] WARNING: zip pattern not found in $EBUN_CLI — Electrobun may have changed"
  fi

  if grep -q 'maxBuffer: 50 \* 1024 \* 1024' "$EBUN_CLI"; then
    echo "[patch-electrobun] maxBuffer already patched"
  elif grep -q 'cwd: dirname(appOrDmgPath),$' "$EBUN_CLI"; then
    sed_in_place 's/cwd: dirname(appOrDmgPath),$/cwd: dirname(appOrDmgPath), maxBuffer: 50 * 1024 * 1024,/g' "$EBUN_CLI"
    echo "[patch-electrobun] Patched maxBuffer"
  else
    echo "[patch-electrobun] WARNING: maxBuffer pattern not found in $EBUN_CLI — Electrobun may have changed"
  fi

  # Add NSCameraUsageDescription to Info.plist (getUserMedia needs it on macOS).
  # Keep this independent from the zip/maxBuffer patches so reused node_modules
  # still get the camera permission string after those patches are already present.
  if grep -q 'NSCameraUsageDescription' "$EBUN_CLI"; then
    echo "[patch-electrobun] NSCameraUsageDescription already patched"
  elif grep -q 'NSAppTransportSecurity' "$EBUN_CLI"; then
    sed_in_place 's|</dict>|<key>NSCameraUsageDescription</key>\n\t<string>KeepKey Vault uses the camera to scan QR codes for wallet addresses.</string>\n</dict>|' "$EBUN_CLI"
    echo "[patch-electrobun] Patched NSCameraUsageDescription"
  else
    echo "[patch-electrobun] WARNING: Info.plist pattern not found — camera permission may not work"
  fi

  # Add NSScreenCaptureUsageDescription (the QR "scan screen" option). Screen
  # Recording itself is pure TCC — no entitlement exists — but newer macOS
  # expects a purpose string on apps that request capture access.
  if grep -q 'NSScreenCaptureUsageDescription' "$EBUN_CLI"; then
    echo "[patch-electrobun] NSScreenCaptureUsageDescription already patched"
  elif grep -q 'NSAppTransportSecurity' "$EBUN_CLI"; then
    sed_in_place 's|</dict>|<key>NSScreenCaptureUsageDescription</key>\n\t<string>KeepKey Vault takes a one-time screenshot to find a QR code on your screen when you choose Scan Screen.</string>\n</dict>|' "$EBUN_CLI"
    echo "[patch-electrobun] Patched NSScreenCaptureUsageDescription"
  else
    echo "[patch-electrobun] WARNING: Info.plist pattern not found — screen recording permission may not work"
  fi
else
  echo "[patch-electrobun] $EBUN_CLI not found, skipping (expected during CI or fresh install)"
fi

# Patch electrobun CLI bootstrap to use --force-local with tar on Windows only.
# Without this, tar interprets the "C:" in Windows paths as a remote host.
# macOS tar does NOT support --force-local — applying it breaks CI macOS builds.
EBUN_CJS="node_modules/electrobun/bin/electrobun.cjs"
if [ -f "$EBUN_CJS" ]; then
  case "$OSTYPE" in
    msys*|cygwin*|win*)
      if grep -q 'tar --force-local' "$EBUN_CJS"; then
        echo "[patch-electrobun] tar --force-local already patched"
      elif grep -q 'tar -xzf' "$EBUN_CJS"; then
        sed -i 's/tar -xzf/tar --force-local -xzf/g' "$EBUN_CJS"
        echo "[patch-electrobun] Patched tar --force-local (Windows path fix)"
      fi
      ;;
    *)
      echo "[patch-electrobun] Skipping tar --force-local (not Windows)"
      ;;
  esac
fi
