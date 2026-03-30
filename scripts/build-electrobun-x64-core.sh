#!/usr/bin/env bash
set -euo pipefail

# Cross-compile Electrobun core binaries for macOS x86_64 (Intel) from ARM64.
# Produces: electrobun-core-darwin-x64.tar.gz containing:
#   launcher, bun (1.1.20), libNativeWrapper.dylib, libasar.dylib
#
# Prerequisites (on ARM64 Mac):
#   - Zig 0.13.0 vendored in modules/electrobun/package/vendors/zig/
#   - CEF headers + wrapper lib in modules/electrobun/package/vendors/cef/
#   - libasar-x64.dylib in modules/electrobun/package/vendors/zig-asar/
#   Run `cd modules/electrobun/package && bun install && bun build.ts` once to vendor deps.
#
# Usage:
#   ./scripts/build-electrobun-x64-core.sh
#   make build-electrobun-x64-core

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTROBUN_PKG="$REPO_ROOT/modules/electrobun/package"
ZIG="$ELECTROBUN_PKG/vendors/zig/zig"
BUN_X64_VERSION="1.1.20"
OUTPUT_DIR="$REPO_ROOT/artifacts"
TARBALL="$OUTPUT_DIR/electrobun-core-darwin-x64.tar.gz"

echo "=== Building Electrobun x64 core from fork ==="

# Verify prerequisites
for F in "$ZIG" \
         "$ELECTROBUN_PKG/src/launcher/build.zig" \
         "$ELECTROBUN_PKG/src/extractor/build.zig" \
         "$ELECTROBUN_PKG/src/native/macos/nativeWrapper.mm" \
         "$ELECTROBUN_PKG/vendors/cef/include" \
         "$ELECTROBUN_PKG/vendors/zig-asar/libasar-x64.dylib"; do
  if [ ! -e "$F" ]; then
    echo "ERROR: Missing prerequisite: $F"
    echo "Run: cd modules/electrobun/package && bun install && bun build.ts"
    exit 1
  fi
done

# Rebuild CEF wrapper for x86_64 if needed
CEF_WRAPPER_X64="$ELECTROBUN_PKG/vendors/cef/build-x64/libcef_dll_wrapper/libcef_dll_wrapper.a"
if [ ! -f "$CEF_WRAPPER_X64" ]; then
  echo "--- Building CEF wrapper for x86_64 ---"
  mkdir -p "$ELECTROBUN_PKG/vendors/cef/build-x64"
  CMAKE_BIN=$(command -v cmake 2>/dev/null || echo "$ELECTROBUN_PKG/vendors/cmake/cmake")
  (cd "$ELECTROBUN_PKG/vendors/cef/build-x64" && \
    "$CMAKE_BIN" \
      -DPROJECT_ARCH=x86_64 \
      -DCMAKE_OSX_ARCHITECTURES=x86_64 \
      -DCMAKE_BUILD_TYPE=Release \
      .. && \
    make -j8 libcef_dll_wrapper)
else
  echo "CEF wrapper (x64) already built"
fi

# Staging directory for output
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/core"

# 1. Build launcher for x86_64
echo "--- Building launcher (x86_64-macos.12.0) ---"
(cd "$ELECTROBUN_PKG/src/launcher" && \
  rm -rf zig-out .zig-cache && \
  "../../vendors/zig/zig" build \
    -Dtarget=x86_64-macos.12.0 \
    -Doptimize=ReleaseSmall)
cp "$ELECTROBUN_PKG/src/launcher/zig-out/bin/launcher" "$STAGING/core/launcher"
echo "  launcher: $(lipo -archs "$STAGING/core/launcher")"

# 2. Build extractor for x86_64 (needed for self-extracting archives)
echo "--- Building extractor (x86_64-macos.12.0) ---"
(cd "$ELECTROBUN_PKG/src/extractor" && \
  rm -rf zig-out .zig-cache && \
  "../../vendors/zig/zig" build \
    -Dtarget=x86_64-macos.12.0 \
    -Doptimize=ReleaseSmall)
cp "$ELECTROBUN_PKG/src/extractor/zig-out/bin/extractor" "$STAGING/core/extractor"
echo "  extractor: $(lipo -archs "$STAGING/core/extractor")"

# 3. Cross-compile libNativeWrapper.dylib for x86_64
echo "--- Building libNativeWrapper.dylib (x86_64, macOS 12.0) ---"
OBJ_DIR="$ELECTROBUN_PKG/src/native/macos/build-x64"
mkdir -p "$OBJ_DIR"

# Check for wgpu include dir (headers are arch-independent, prefer x64 but fall back to arm64)
WGPU_INC="$ELECTROBUN_PKG/vendors/wgpu/macos-x64/include"
[ -d "$WGPU_INC" ] || WGPU_INC="$ELECTROBUN_PKG/vendors/wgpu/macos-arm64/include"
WGPU_FLAG=""
if [ -d "$WGPU_INC" ]; then
  WGPU_FLAG="-I$WGPU_INC"
fi

# Compile ObjC++ source for x86_64
clang++ \
  -arch x86_64 \
  -mmacosx-version-min=12.0 \
  -c "$ELECTROBUN_PKG/src/native/macos/nativeWrapper.mm" \
  -o "$OBJ_DIR/nativeWrapper.o" \
  -fobjc-arc \
  -fno-objc-msgsend-selector-stubs \
  -I"$ELECTROBUN_PKG/vendors/cef" \
  $WGPU_FLAG \
  -std=c++20

# Link into dylib using x64 libasar and x64 CEF wrapper
clang++ \
  -arch x86_64 \
  -mmacosx-version-min=12.0 \
  -o "$STAGING/core/libNativeWrapper.dylib" \
  "$OBJ_DIR/nativeWrapper.o" \
  "$ELECTROBUN_PKG/vendors/zig-asar/libasar-x64.dylib" \
  -framework Cocoa \
  -framework WebKit \
  -framework QuartzCore \
  -framework Metal \
  -framework MetalKit \
  -framework UserNotifications \
  -F"$ELECTROBUN_PKG/vendors/cef/Release" \
  -weak_framework 'Chromium Embedded Framework' \
  -L"$ELECTROBUN_PKG/vendors/cef/build-x64/libcef_dll_wrapper" \
  -lcef_dll_wrapper \
  -stdlib=libc++ \
  -shared \
  -install_name @executable_path/libNativeWrapper.dylib \
  -Wl,-rpath,@executable_path

echo "  libNativeWrapper.dylib: $(lipo -archs "$STAGING/core/libNativeWrapper.dylib")"

# 4. Copy libasar.dylib (x64 version already vendored)
cp "$ELECTROBUN_PKG/vendors/zig-asar/libasar-x64.dylib" "$STAGING/core/libasar.dylib"
echo "  libasar.dylib: $(lipo -archs "$STAGING/core/libasar.dylib")"

# 5. Download bun 1.1.20 for darwin-x64 (last version supporting macOS 12)
echo "--- Downloading bun $BUN_X64_VERSION for darwin-x64 ---"
BUN_ZIP="$STAGING/bun.zip"
curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_X64_VERSION}/bun-darwin-x64.zip" \
  -o "$BUN_ZIP"
(cd "$STAGING" && unzip -q "$BUN_ZIP")
cp "$STAGING/bun-darwin-x64/bun" "$STAGING/core/bun"
rm -rf "$STAGING/bun-darwin-x64" "$BUN_ZIP"
echo "  bun: $(lipo -archs "$STAGING/core/bun") (v$BUN_X64_VERSION)"

# 6. Copy zig-zstd and zig-bsdiff if available (used by Electrobun for updates)
for TOOL in zig-zstd bsdiff bspatch; do
  SRC="$ELECTROBUN_PKG/vendors/zig-bsdiff/$TOOL"
  [ -f "$SRC" ] || SRC="$ELECTROBUN_PKG/vendors/zig-zstd/$TOOL"
  if [ -f "$SRC" ]; then
    # These are only available for the host arch, skip if not x64
    TOOL_ARCH=$(lipo -archs "$SRC" 2>/dev/null || echo "unknown")
    if [ "$TOOL_ARCH" = "x86_64" ]; then
      cp "$SRC" "$STAGING/core/$TOOL"
    fi
  fi
done

# Verify all core binaries are x86_64
echo ""
echo "=== Verifying all binaries ==="
FAIL=0
for BIN in launcher bun libNativeWrapper.dylib libasar.dylib; do
  ACTUAL=$(lipo -archs "$STAGING/core/$BIN" 2>/dev/null)
  echo "  $BIN: $ACTUAL"
  if [ "$ACTUAL" != "x86_64" ]; then
    echo "  ERROR: Expected x86_64, got $ACTUAL"
    FAIL=1
  fi
done
if [ "$FAIL" = "1" ]; then
  echo "ERROR: Architecture verification failed"
  exit 1
fi

# Also verify libNativeWrapper does NOT contain resign swizzle (the whole point of this!)
echo ""
echo "=== Verifying no resign-swizzle symbols ==="
if nm "$STAGING/core/libNativeWrapper.dylib" 2>/dev/null | grep -q "resignKeyWindow"; then
  echo "ERROR: libNativeWrapper.dylib contains resignKeyWindow symbols!"
  echo "This binary was NOT built from the fork source."
  nm "$STAGING/core/libNativeWrapper.dylib" | grep resignKeyWindow
  exit 1
fi
echo "  No resign-swizzle symbols found (correct)"

# Package as tarball
mkdir -p "$OUTPUT_DIR"
echo ""
echo "=== Packaging ==="
(cd "$STAGING/core" && tar czf "$TARBALL" .)
echo "Created: $TARBALL ($(du -h "$TARBALL" | cut -f1))"
echo ""
echo "Contents:"
tar tzf "$TARBALL"
echo ""
echo "=== Done ==="
echo "Next steps:"
echo "  1. Publish to fork:  make publish-electrobun-x64-core"
echo "  2. Or manually:      gh release create v1.16.1-keepkey.1 --repo BitHighlander/electrobun \\"
echo "                          --title 'Electrobun Core x64 (macOS 12 support)' \\"
echo "                          $TARBALL"
