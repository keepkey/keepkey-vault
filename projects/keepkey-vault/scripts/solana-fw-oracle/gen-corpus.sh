#!/bin/bash
# Regenerate __tests__/fixtures/solana/certified-firmware-verdicts.json from
# the firmware's own solana.c at a committed revision.
#
# usage: scripts/solana-fw-oracle/gen-corpus.sh <keepkey-firmware checkout> <rev> <pb include dir> <nanopb dir>
#   <pb include dir>  a firmware build's include/ (holds messages-solana.pb.h)
#   <nanopb dir>      the nanopb the firmware builds with (holds pb.h)
# Run from projects/keepkey-vault. The firmware checkout is only read: the
# sources come from `git archive <rev>`, the crypto from its submodule, which
# must be at the commit <rev> pins.
set -euo pipefail
FW=$1 REV=$2 PB_INCLUDE=$3 NANOPB=$4
HERE=$(cd "$(dirname "$0")" && pwd)
SHA=$(git -C "$FW" rev-parse --verify "$REV^{commit}")
CRYPTO_PIN=$(git -C "$FW" ls-tree "$SHA" deps/crypto/trezor-firmware | awk '{print $3}')
CRYPTO_HEAD=$(git -C "$FW/deps/crypto/trezor-firmware" rev-parse HEAD)
[ "$CRYPTO_PIN" = "$CRYPTO_HEAD" ] || { echo "trezor-firmware is at $CRYPTO_HEAD, $SHA pins $CRYPTO_PIN" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git -C "$FW" archive "$SHA" lib/firmware/solana.c lib/firmware/fsm_msg_solana.h include | tar -x -C "$WORK"
mkdir "$WORK/inc" && ln -s "$FW/deps/crypto/trezor-firmware" "$WORK/inc/trezor"
awk '/^static bool solana_validatePriorityFee\(/,/^}/' "$WORK/lib/firmware/fsm_msg_solana.h" > "$WORK/fee.inc"
[ -s "$WORK/fee.inc" ] || { echo "solana_validatePriorityFee not found in fsm_msg_solana.h" >&2; exit 1; }

C=$FW/deps/crypto/trezor-firmware/crypto
cc -O1 -w -I "$WORK" -I "$WORK/include" -I "$WORK/inc" -I "$PB_INCLUDE" -I "$NANOPB" -I "$C" \
  "$HERE/harness.c" "$HERE/stubs.c" "$WORK/lib/firmware/solana.c" "$C/base58.c" "$C/sha2.c" "$C/memzero.c" \
  -o "$WORK/harness"

bun "$HERE/gen-corpus.ts" "$WORK/harness" \
  "keepkey-firmware $SHA ($(git -C "$FW" log -1 --format=%s "$SHA")), trezor-firmware $CRYPTO_PIN" \
  "scripts/solana-fw-oracle/gen-corpus.sh <keepkey-firmware> $SHA <build>/include <nanopb-0.3.9.4>"
