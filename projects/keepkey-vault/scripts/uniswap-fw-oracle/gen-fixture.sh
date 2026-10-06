#!/bin/bash
# Regenerate __tests__/fixtures/uniswap/ur-firmware-parity.json.gz from the
# firmware's own Universal Router decoder at a committed revision.
#
# usage: scripts/uniswap-fw-oracle/gen-fixture.sh <keepkey-firmware checkout> <rev>
# Run from projects/keepkey-vault. The firmware checkout is only read: the
# decoder, the D-021 sample, the vectors and the Python model's expectations
# all come from `git archive <rev>`.
set -euo pipefail
FW=$1 REV=$2
HERE=$(cd "$(dirname "$0")" && pwd)
SHA=$(git -C "$FW" rev-parse --verify "$REV^{commit}")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git -C "$FW" archive "$SHA" lib/firmware/uniswap_ur.c include/keepkey/firmware/uniswap_ur.h \
  unittests/firmware/uniswap_ur_sample.bin unittests/firmware/uniswap_ur_vectors.h \
  unittests/firmware/uniswap_ur_expected.txt | tar -x -C "$WORK"
cc -O2 -std=c99 -Wall -Werror -I "$WORK/include" "$HERE/harness.c" "$WORK/lib/firmware/uniswap_ur.c" -o "$WORK/harness"
bun "$HERE/gen-fixture.ts" "$WORK" "$SHA" "__tests__/fixtures/uniswap/ur-firmware-parity.json.gz"
