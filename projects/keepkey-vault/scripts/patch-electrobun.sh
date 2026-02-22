#!/bin/bash
# Patch Electrobun's notarization zip to use quiet mode + larger buffer
# This prevents ENOBUFS when the app bundle has many files (native node_modules)
EBUN_CLI="node_modules/electrobun/src/cli/index.ts"
if [ -f "$EBUN_CLI" ]; then
  # Check if already patched (idempotent)
  if grep -q 'zip -y -r -q -9' "$EBUN_CLI"; then
    echo "[patch-electrobun] Already patched, skipping"
    exit 0
  fi
  # Add -q flag to zip commands and increase maxBuffer
  if grep -q '`zip -y -r -9' "$EBUN_CLI"; then
    sed -i '' 's/`zip -y -r -9/`zip -y -r -q -9/g' "$EBUN_CLI"
    echo "[patch-electrobun] Patched zip quiet mode"
  else
    echo "[patch-electrobun] WARNING: zip pattern not found in $EBUN_CLI — Electrobun may have changed"
  fi
  if grep -q 'cwd: dirname(appOrDmgPath),$' "$EBUN_CLI"; then
    sed -i '' 's/cwd: dirname(appOrDmgPath),$/cwd: dirname(appOrDmgPath), maxBuffer: 50 * 1024 * 1024,/g' "$EBUN_CLI"
    echo "[patch-electrobun] Patched maxBuffer"
  else
    echo "[patch-electrobun] WARNING: maxBuffer pattern not found in $EBUN_CLI — Electrobun may have changed"
  fi
else
  echo "[patch-electrobun] $EBUN_CLI not found, skipping (expected during CI or fresh install)"
fi
