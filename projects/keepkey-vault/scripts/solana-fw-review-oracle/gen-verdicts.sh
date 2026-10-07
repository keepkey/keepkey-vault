#!/bin/bash
# Regenerate __tests__/fixtures/solana/advanced-mode-firmware-verdicts.json:
# wire transactions with the review verdict of each firmware build's own
# lib/firmware/solana.c.
#
# usage: scripts/solana-fw-review-oracle/gen-verdicts.sh <keepkey-firmware checkout> <rev>...
# Run from projects/keepkey-vault. The checkout is only read (`git archive`).
# Only the classifier is compiled: solana.c up to the end of solana_inspectTx,
# which needs no crypto, so the protobuf and trezor-crypto headers are stubs.
set -euo pipefail
FW=$1
shift
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/stub/trezor/crypto/ed25519-donna"
cat > "$WORK/stub/messages-solana.pb.h" <<'EOF'
typedef struct _SolanaSignTx SolanaSignTx;
typedef struct _SolanaSignedTx SolanaSignedTx;
typedef struct _SolanaSignMessage SolanaSignMessage;
typedef struct _SolanaSignOffchainMessage SolanaSignOffchainMessage;
typedef struct _SolanaOffchainMessageSignature SolanaOffchainMessageSignature;
typedef struct _SolanaTokenInfo SolanaTokenInfo;
EOF
echo 'typedef struct HDNode HDNode;' > "$WORK/stub/trezor/crypto/bip32.h"
for h in memzero.h sha2.h ed25519-donna/ed25519-donna.h; do : > "$WORK/stub/trezor/crypto/$h"; done

BUILDS=()
SHAS=()
for REV in "$@"; do
  SHA=$(git -C "$FW" rev-parse --verify "$REV^{commit}")
  SRC="$WORK/$SHA"
  mkdir -p "$SRC"
  git -C "$FW" archive "$SHA" lib/firmware/solana.c include/keepkey/firmware CMakeLists.txt | tar -x -C "$SRC"
  awk '/^bool solana_parseTx\(|^SolanaTxReview solana_inspectTxWithTrustedLut\(|KKSOLSC1 reusable instruction schemas/{exit} {print}' \
    "$SRC/lib/firmware/solana.c" > "$SRC/classifier.c"
  grep -q '^SolanaTxReview solana_inspectTx(' "$SRC/classifier.c" || { echo "solana_inspectTx not found at $REV" >&2; exit 1; }
  VERSION=$(awk '/^project\(/{p=1} p && /VERSION/{print $2; exit}' "$SRC/CMakeLists.txt")
  cc -O1 -w -I "$WORK/stub" -I "$SRC/include" "$HERE/harness.c" "$SRC/classifier.c" -o "$SRC/harness"
  SHAS+=("$SHA")
  BUILDS+=("$REV" "$SHA" "$VERSION" "$(git -C "$FW" log -1 --format=%s "$SHA")" "$SRC/harness")
done

bun "$HERE/gen-verdicts.ts" "scripts/solana-fw-review-oracle/gen-verdicts.sh <keepkey-firmware> ${SHAS[*]}" "${BUILDS[@]}"
