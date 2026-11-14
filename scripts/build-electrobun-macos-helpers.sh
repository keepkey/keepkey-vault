#!/usr/bin/env bash
set -euo pipefail

# Electrobun 2.x builds its launcher, core and native wrapper from our fork with
# ELECTROBUN_MACOS_DEPLOYMENT_TARGET, but downloads three helper tools prebuilt
# for macOS 14: libasar.dylib, zig-zstd and bspatch, all shipped inside the app.
# Rebuild them from the exact upstream release commits for our floor and place
# them in the fork's vendors/ with the .version key build.ts accepts, so the next
# devkit build uses them instead of downloading. The macOS audit
# (scripts/audit-macos-bundle.sh) is what proves the shipped floor.
#
# Usage: scripts/build-electrobun-macos-helpers.sh [macos-target]   (default 13.0)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$REPO_ROOT/modules/electrobun/package"
TARGET="${1:-13.0}"
[ "$(uname -s)" = Darwin ] || { echo "ERROR: macOS only"; exit 1; }
case "$(uname -m)" in
  arm64) ARCH=arm64; ZIG_ARCH=aarch64; ZIG_SHA=b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a ;;
  x86_64) ARCH=x64; ZIG_ARCH=x86_64; ZIG_SHA=4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6 ;;
  *) echo "ERROR: unsupported architecture $(uname -m)"; exit 1 ;;
esac
ZIG_VERSION=0.17.0
ZIG_TARGET="$ZIG_ARCH-macos.$TARGET"

# Versions must match OWNED_BUILD_DEPENDENCY_VERSIONS in the fork; commits are
# the peeled upstream release tags (blackboardsh/<repo> v<version>).
versions="$(sed -n 's/^[[:space:]]*"\(zig-[a-z]*\)": "\([0-9.]*\)",*$/\1=\2/p' "$PKG/src/shared/build-dependencies.ts" \
  | awk -F= '{a[$1]=$2} END {print a["zig-asar"], a["zig-zstd"], a["zig-bsdiff"]}')"
read -r ASAR_VERSION ZSTD_VERSION BSDIFF_VERSION <<<"$versions"
[ "$ASAR_VERSION" = 0.2.8 ] && [ "$ZSTD_VERSION" = 0.1.9 ] && [ "$BSDIFF_VERSION" = 0.1.26 ] || {
  echo "ERROR: fork helper versions are '$versions'; update the pinned commits in $0"; exit 1; }
ASAR_COMMIT=3b80a870c4353b8b69fb574f4a58038b5a7f304c
ZSTD_COMMIT=bc11c276480737d7d9d6be328c78af9a78d7f06a
BSDIFF_COMMIT=f8b30fa6a696da7a1886a3a23d38df2ee9323f76

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Fetching Zig $ZIG_VERSION ($ZIG_ARCH-macos)..."
curl -fsSL --retry 5 -o "$work/zig.tar.xz" "https://ziglang.org/download/$ZIG_VERSION/zig-$ZIG_ARCH-macos-$ZIG_VERSION.tar.xz"
echo "$ZIG_SHA  $work/zig.tar.xz" | shasum -a 256 -c -
mkdir -p "$work/zig" && tar -xJf "$work/zig.tar.xz" --strip-components=1 -C "$work/zig"
ZIG="$work/zig/zig"

clone() { # repo version commit
  git clone --quiet --recurse-submodules --shallow-submodules --depth 1 --branch "v$2" \
    "https://github.com/blackboardsh/$1.git" "$work/$1"
  [ "$(git -C "$work/$1" rev-parse HEAD)" = "$3" ] || { echo "ERROR: $1 v$2 is not commit $3"; exit 1; }
  mkdir -p "$work/$1/vendors" && ln -sfn "$work/zig" "$work/$1/vendors/zig"
}

clone zig-asar "$ASAR_VERSION" "$ASAR_COMMIT"
(cd "$work/zig-asar" && "$ZIG" build -Doptimize=ReleaseFast -Dcpu=baseline -Dtarget="$ZIG_TARGET")
# As zig-asar's own release does: Zig's Mach-O linker exports ___dso_handle,
# which breaks Apple ld links against libasar.dylib (libNativeWrapper:
# "fixup error ... ___dso_handle does not have address"). Re-link from the
# static archive with the C API as the only exports.
(cd "$work/zig-asar" && clang -dynamiclib -arch "$(uname -m)" -mmacosx-version-min="$TARGET" \
  -o zig-out/lib/libasar.dylib \
  -Wl,-force_load,zig-out/lib/libasar-static.a \
  -exported_symbols_list scripts/asar-exported-symbols.txt \
  -Wl,-headerpad,0x1000 \
  -install_name @rpath/libasar.dylib)
if nm -gU "$work/zig-asar/zig-out/lib/libasar.dylib" | grep -q dso_handle; then
  echo "ERROR: libasar.dylib still exports ___dso_handle"; exit 1
fi
clone zig-zstd "$ZSTD_VERSION" "$ZSTD_COMMIT"
(cd "$work/zig-zstd" && node scripts/setup.js && "$ZIG" build -Doptimize=ReleaseFast -Dcpu=baseline -Dtarget="$ZIG_TARGET")
clone zig-bsdiff "$BSDIFF_VERSION" "$BSDIFF_COMMIT"
(cd "$work/zig-bsdiff" && node scripts/setup.js --target="$ZIG_TARGET" && "$ZIG" build -Doptimize=ReleaseFast -Dcpu=baseline -Dtarget="$ZIG_TARGET")

install_helper() { # vendor-dir version file...
  local dir="$PKG/vendors/$1" version="$2"; shift 2
  rm -rf "$dir" && mkdir -p "$dir"
  for f in "$@"; do cp "$f" "$dir/"; done
  printf '%s\n' "$version-macos-$ARCH" > "$dir/.version"
}
install_helper zig-asar "$ASAR_VERSION" "$work/zig-asar/zig-out/lib/libasar.dylib" "$work/zig-asar/zig-out/bin/zig-asar"
install_helper zig-zstd "$ZSTD_VERSION" "$work/zig-zstd/zig-out/bin/zig-zstd"
install_helper zig-bsdiff "$BSDIFF_VERSION" "$work/zig-bsdiff/zig-out/bin/bsdiff" "$work/zig-bsdiff/zig-out/bin/bspatch"

want="$(uname -m)"
for f in "$PKG"/vendors/zig-asar/{libasar.dylib,zig-asar} "$PKG"/vendors/zig-zstd/zig-zstd "$PKG"/vendors/zig-bsdiff/{bsdiff,bspatch}; do
  codesign --force --sign - "$f"
  [ "$(lipo -archs "$f")" = "$want" ] || { echo "ERROR: $f is not $want"; exit 1; }
  minos="$(vtool -show-build "$f" | awk '$1 == "minos" { print $2; exit }')"
  [ "$minos" = "$TARGET" ] || { echo "ERROR: $f requires macOS $minos, wanted $TARGET"; exit 1; }
  echo "$(basename "$f"): $want, macOS $minos"
done
echo "Electrobun helpers for macOS $TARGET are in $PKG/vendors"
