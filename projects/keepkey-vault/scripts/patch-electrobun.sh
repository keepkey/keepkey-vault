#!/bin/bash
# Patch Electrobun inside node_modules.
#
# EVERY patch here hard-fails when its target file or its anchor is missing.
# The previous version warned-and-continued, which let two patches rot into
# silent no-ops across five Electrobun releases without anyone noticing. A
# skipped patch means a shipped bug, so a miss must break the install.
#
# macOS Info.plist keys are NOT patched here — declare the entitlement in
# electrobun.config.ts instead; upstream's CLI maps entitlements to their
# usage-description keys (see its ENTITLEMENT_TO_PLIST map).
set -euo pipefail

EBUN="node_modules/electrobun"

note() { echo "[patch-electrobun] $*"; }
die() {
  echo "[patch-electrobun] ERROR: $*" >&2
  exit 1
}

sed_in_place() { sed -i.bak "$1" "$2" && rm -f "$2.bak"; }

# patch_files <label> <marker> <anchor> <sed-expr> <file>...
# marker = proof the patch is already applied; anchor = the upstream text we rewrite.
# Unmatched glob args stay literal and are filtered by [ -f ]; zero matches is fatal.
patch_files() {
  local label=$1 marker=$2 anchor=$3 expr=$4
  shift 4
  local found=0 f
  for f in "$@"; do
    [ -f "$f" ] || continue
    found=$((found + 1))
    if grep -q "$marker" "$f"; then
      note "$label: already patched ($f)"
    elif grep -q "$anchor" "$f"; then
      sed_in_place "$expr" "$f"
      note "$label: patched ($f)"
    else
      die "$label: anchor not found in $f. Electrobun changed upstream — re-point this patch before shipping."
    fi
  done
  [ "$found" -gt 0 ] || die "$label: no target file matched ($*). Electrobun changed its package layout."
}

# --- CLI: quiet zip + bigger buffer (prevents ENOBUFS on the ~50MB app zip) ---

patch_files "zip quiet mode" \
  'zip -y -r -q -9' \
  '`zip -y -r -9' \
  's/`zip -y -r -9/`zip -y -r -q -9/g' \
  "$EBUN/src/cli/index.ts"

patch_files "zip maxBuffer" \
  'maxBuffer: 50 \* 1024 \* 1024' \
  'cwd: dirname(appOrDmgPath),$' \
  's/cwd: dirname(appOrDmgPath),$/cwd: dirname(appOrDmgPath), maxBuffer: 50 * 1024 * 1024,/g' \
  "$EBUN/src/cli/index.ts"

# --- RPC dispatcher: never swallow a non-Error throw ---
#
# hdwallet throws decoded protobuf Failure objects (plain objects whose .message
# is {code, message}). Upstream does `if (!(error instanceof Error)) throw error;`
# which sends NO response packet at all — the renderer's request then hangs until
# its own timeout and the device's real reason ("Enable AdvancedMode to
# blind-sign", "PIN invalid", …) is lost. Normalize instead of re-throwing.
#
# The replacement re-states the original `throw` guard after normalizing. It can
# never fire (error is an Error by then), but `catch (error)` types error as
# unknown and a plain assignment does not re-narrow it — without the second guard
# the `error.message` below fails to typecheck and shows up as preflight drift.
#
# The platform core tarball unpacked by `electrobun build` also carries an api/,
# and it lands after this script runs. Today the build bundles the shared dist/
# copy patched here; scripts/prune-app-bundle.ts asserts the markers survive into
# the shipped app so a flipped preference fails the release instead of shipping
# silently unpatched. The dist-* glob below covers the copy if it already exists.
patch_files "rpc.ts device-error normalization" \
  'kkDeviceErrorText' \
  'if (!(error instanceof Error)) throw error;' \
  's|if (!(error instanceof Error)) throw error;|if (!(error instanceof Error)) { const kkDeviceErrorText = (e: any): string => typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof e?.message?.message === "string" ? e.message.message : String(e); error = new Error(kkDeviceErrorText(error)); } if (!(error instanceof Error)) throw error;|g' \
  "$EBUN"/dist/api/shared/rpc.ts "$EBUN"/dist-*/api/shared/rpc.ts

# --- Preload: retry initEncryption when crypto.subtle isn't ready yet ---
#
# On slow startups the preload user-script can run while the webview is still in
# a transient context (about:blank before views:// is established) where
# crypto.subtle is undefined — importKey throws, __electrobun_encrypt/decrypt
# never install, and ALL bun<->webview RPC is dead (blank window / "import key
# broke"). Bounded 100ms x 50 retry wins the race; logs loudly if crypto.subtle
# never appears. Uses bun rather than sed because the replacement spans quotes
# sed would have to escape into illegibility.
enc_found=0
for COMPILED in "$EBUN"/dist/api/bun/preload/.generated/compiled.ts \
  "$EBUN"/dist-*/api/bun/preload/.generated/compiled.ts; do
  [ -f "$COMPILED" ] || continue
  enc_found=$((enc_found + 1))
  if grep -q '__ebInitEncRetry' "$COMPILED"; then
    note "encryption retry: already patched ($COMPILED)"
    continue
  fi
  bun -e '
const fs = require("fs");
const f = process.argv[1];
let s = fs.readFileSync(f, "utf8");
const target = String.raw`initEncryption().catch((err) => console.error(\"Failed to initialize encryption:\", err));`;
const replacement = String.raw`var __ebInitEncRetry = (attempt) => initEncryption().catch((err) => { if (attempt < 50) { setTimeout(() => __ebInitEncRetry(attempt + 1), 100); } else { console.error(\"Failed to initialize encryption (crypto.subtle unavailable after 5s):\", err); } }); __ebInitEncRetry(0);`;
if (!s.includes(target)) { console.error("initEncryption pattern not found in " + f); process.exit(1); }
fs.writeFileSync(f, s.replaceAll(target, replacement));
' "$COMPILED" ||
    die "encryption retry: anchor not found in $COMPILED. Electrobun changed its preload — re-point this patch before shipping."
  note "encryption retry: patched ($COMPILED)"
done
[ "$enc_found" -gt 0 ] || die "encryption retry: no compiled preload matched. Electrobun changed its package layout."
