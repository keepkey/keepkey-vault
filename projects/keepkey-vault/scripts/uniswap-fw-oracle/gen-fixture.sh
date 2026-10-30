#!/bin/bash
# Regenerate __tests__/fixtures/uniswap/ur-firmware-parity.json.gz from the
# firmware's own Universal Router decoder at a committed revision.
#
# usage: scripts/uniswap-fw-oracle/gen-fixture.sh <keepkey-firmware checkout> <rev> [out.json.gz]
# Run from projects/keepkey-vault. The firmware checkout is only read: the
# decoder, the D-021 sample, the vectors and the Python model's expectations
# all come from `git archive <rev>`.
#   51f85368e -> __tests__/fixtures/uniswap/ur-firmware-parity.json.gz (7.16)
#   296aa1e2c -> __tests__/fixtures/uniswap/ur-firmware-parity-717.json.gz
set -euo pipefail
FW=$1 REV=$2 OUT=${3:-__tests__/fixtures/uniswap/ur-firmware-parity.json.gz}
HERE=$(cd "$(dirname "$0")" && pwd)
SHA=$(git -C "$FW" rev-parse --verify "$REV^{commit}")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
FILES="lib/firmware/uniswap_ur.c include/keepkey/firmware/uniswap_ur.h unittests/firmware/uniswap_ur_sample.bin
  unittests/firmware/uniswap_ur_vectors.h unittests/firmware/uniswap_ur_expected.txt"
# 7.17: other wallets' public calls (rw lines). uniswap_ur_v4_routers.h (v4x/v4y)
# is left out: it is one wallet's own swaps.
if git -C "$FW" cat-file -e "$SHA:unittests/firmware/uniswap_ur_realworld.h" 2>/dev/null; then
  FILES="$FILES unittests/firmware/uniswap_ur_realworld.h"
fi
git -C "$FW" archive "$SHA" $FILES | tar -x -C "$WORK"
DEFS=""
grep -q 'ur_decode(const uint8_t\* calldata, size_t len, const uint8_t router' "$WORK/include/keepkey/firmware/uniswap_ur.h" && DEFS="$DEFS -DUR_DECODE_ROUTER"
grep -q 'fee_amount\[32\]' "$WORK/include/keepkey/firmware/uniswap_ur.h" && DEFS="$DEFS -DUR_FEE_AMOUNT"
cc -O2 -std=c99 -Wall -Werror $DEFS -I "$WORK/include" "$HERE/harness.c" "$WORK/lib/firmware/uniswap_ur.c" -o "$WORK/harness"
BY_ROUTER=""
case "$DEFS" in *UR_DECODE_ROUTER*) BY_ROUTER=1 ;; esac
UR_DECODE_ROUTER=$BY_ROUTER bun "$HERE/gen-fixture.ts" "$WORK" "$SHA" "$OUT"
