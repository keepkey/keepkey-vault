#!/usr/bin/env bash
# nanopb 0.3.9.x expects -fFILE while the firmware CMake currently emits
# "-f FILE" inside --nanopb_out. Newer protoc passes that leading space
# through literally, so nanopb silently ignores every .options file and the
# build later fails (or, without the callback gate, produces the wrong ABI).
set -euo pipefail

REAL_PROTOC="${KK_REAL_PROTOC:-}"
if [ -z "$REAL_PROTOC" ]; then
  echo "ERROR: KK_REAL_PROTOC must point to the pinned protoc binary" >&2
  exit 1
fi

fixed=()
for arg in "$@"; do
  case "$arg" in
    "--nanopb_out=-f "*) fixed+=("--nanopb_out=-f${arg#--nanopb_out=-f }") ;;
    *) fixed+=("$arg") ;;
  esac
done

exec "$REAL_PROTOC" "${fixed[@]}"
