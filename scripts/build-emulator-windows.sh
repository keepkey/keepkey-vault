#!/usr/bin/env bash
# Cross-compile the Windows emulator DLL (libkkemu.dll) from this macOS/Linux
# host using MinGW-w64. Produces the SAME 8-symbol FFI library the vault loads
# on macOS (libkkemu.dylib) — just as a Windows .dll.
#
#   ┌───────────────────────────────────────────────────────────────────┐
#   │ This is NOT the emulator used in firmware CI.                        │
#   │   • firmware CI builds the standalone UDP `kkemu` binary (sockets,   │
#   │     :11044/:11045) for python-keepkey tests + OLED screenshots.      │
#   │   • THIS builds libkkemu.dll — the in-process, ring-buffer FFI lib   │
#   │     the vault loads via bun:ffi (the .dll sibling of .dylib/.so).    │
#   └───────────────────────────────────────────────────────────────────┘
#
# Invoke via `make build-emulator-windows` (preferred). Requires MinGW-w64:
#   macOS:  brew install mingw-w64
#   Linux:  apt-get install mingw-w64
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FW_DIR="$REPO_ROOT/modules/keepkey-firmware"
BUILD_DIR="$FW_DIR/build-emu-win"
TOOLCHAIN_FILE="cmake/toolchains/mingw-w64-x86_64.cmake"
TC_CACHE="$HOME/.keepkey/emulator/.toolchain"
PROTOC_VERSION=21.12

echo "=== Windows emulator DLL cross-compile ==="
command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || {
  echo "ERROR: x86_64-w64-mingw32-gcc not found. Install: brew install mingw-w64"; exit 1; }
echo "    MinGW:  $(x86_64-w64-mingw32-gcc --version | head -1)"

# --- Pinned host build toolchain (matches firmware CI dylib job) -------------
# protobuf 3.20.3 + nanopb 0.3.9.4 live in pyenv 3.10.15; protoc is pinned to
# 3.21.x so generated descriptors match the 3.20 runtime.
PYENV_BIN="$HOME/.pyenv/versions/3.10.15/bin"
[ -d "$PYENV_BIN" ] || { echo "ERROR: pyenv 3.10.15 not found at $PYENV_BIN"; exit 1; }
NANOPB_GEN_DIR="$("$PYENV_BIN/python" -c 'import os,nanopb;print(os.path.dirname(nanopb.__file__))')/generator"

# Fetch pinned protoc once (cached). osx-aarch_64 / linux-x86_64.
PROTOC_BIN="$TC_CACHE/protoc-$PROTOC_VERSION/bin/protoc"
if [ ! -x "$PROTOC_BIN" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) ASSET="protoc-$PROTOC_VERSION-osx-aarch_64.zip" ;;
    Darwin-x86_64) ASSET="protoc-$PROTOC_VERSION-osx-x86_64.zip" ;;
    Linux-x86_64) ASSET="protoc-$PROTOC_VERSION-linux-x86_64.zip" ;;
    *) echo "ERROR: no pinned protoc asset for $(uname -s)-$(uname -m)"; exit 1 ;;
  esac
  echo "    Fetching pinned protoc $PROTOC_VERSION ($ASSET)..."
  mkdir -p "$TC_CACHE/protoc-$PROTOC_VERSION"
  curl -sSL -fL -o /tmp/protoc-pin.zip \
    "https://github.com/protocolbuffers/protobuf/releases/download/v$PROTOC_VERSION/$ASSET"
  unzip -oq /tmp/protoc-pin.zip -d "$TC_CACHE/protoc-$PROTOC_VERSION"
  chmod +x "$PROTOC_BIN"
fi
echo "    protoc: $("$PROTOC_BIN" --version)"

export PATH="$(dirname "$PROTOC_BIN"):$PYENV_BIN:$NANOPB_GEN_DIR:$PATH"
NANOPB_DIR="$("$PYENV_BIN/python" -c 'import os,nanopb;print(os.path.dirname(nanopb.__file__))')"
NANOPB_PLUGIN="$(command -v protoc-gen-nanopb)"

# --- Configure + build only the dylib target --------------------------------
echo "=== Source SHA: $(cd "$FW_DIR" && git rev-parse HEAD) ==="
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
( cd "$FW_DIR" && cmake -S . -B build-emu-win \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" \
    -DKK_EMULATOR=ON -DKK_DEBUG_LINK=ON -DKK_BUILD_DYLIB=ON \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DPROTOC_BINARY="$PROTOC_BIN" \
    -DNANOPB_DIR="$NANOPB_DIR" -DNANOPB_PLUGIN="$NANOPB_PLUGIN" \
    -DCMAKE_C_FLAGS="-DPB_NO_PACKED_STRUCTS=1" \
    -DCMAKE_CXX_FLAGS="-DPB_NO_PACKED_STRUCTS=1" )

( cd "$FW_DIR" && cmake --build build-emu-win --target kkemulator_dylib -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" )

DLL="$(find "$BUILD_DIR" -name 'libkkemu.dll' -o -name 'kkemu.dll' | head -1)"
if [ -n "$DLL" ] && [ -f "$DLL" ]; then
  echo "=== SUCCESS: $DLL ==="
  x86_64-w64-mingw32-objdump -p "$DLL" | grep -A20 "Export" | grep -i kkemu || true
else
  echo "=== FAILED: no libkkemu.dll produced ==="; exit 1
fi
