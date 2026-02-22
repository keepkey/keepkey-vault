#!/bin/bash
# Patch Electrobun's notarization zip to use quiet mode + larger buffer
# This prevents ENOBUFS when the app bundle has many files (native node_modules)
EBUN_CLI="node_modules/electrobun/src/cli/index.ts"
if [ -f "$EBUN_CLI" ]; then
  # Add -q flag to zip commands and increase maxBuffer
  sed -i '' 's/`zip -y -r -9/`zip -y -r -q -9/g' "$EBUN_CLI"
  sed -i '' 's/cwd: dirname(appOrDmgPath),$/cwd: dirname(appOrDmgPath), maxBuffer: 50 * 1024 * 1024,/g' "$EBUN_CLI"
  echo "[patch-electrobun] Patched zip quiet mode + maxBuffer"
fi
