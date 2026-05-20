#!/usr/bin/env bash
set -euo pipefail

# Build Electrobun core artifacts for Linux x86_64 against an older glibc.
# Produces: artifacts/electrobun-core-linux-x64.tar.gz
# Contains: launcher, extractor, libNativeWrapper.so, libNativeWrapper_cef.so, libasar.so, bun
#
# Why: upstream blackboardsh/electrobun ships its core tarball compiled on a
# newer Ubuntu image, which makes libNativeWrapper.so depend on glibc 2.38.
# That excludes Debian 12 (2.36), Ubuntu 22.04 LTS (2.35), RHEL/Rocky 9 (2.34).
# By building on Ubuntu 22.04 ourselves, we get a glibc 2.35 floor.
#
# Designed to run in CI on ubuntu-22.04. Will refuse to run elsewhere unless
# ALLOW_NON_2204=1 is set (e.g. when iterating in a container).
#
# Pinned to upstream tag v1.13.1 by default (matches the npm `electrobun@1.13.1`
# the runtime depends on). Override with ELECTROBUN_REF=<tag-or-branch>.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBMODULE="$REPO_ROOT/modules/electrobun"
PKG_DIR="$SUBMODULE/package"
OUTPUT_DIR="$REPO_ROOT/artifacts"
TARBALL="$OUTPUT_DIR/electrobun-core-linux-x64.tar.gz"
ELECTROBUN_REF="${ELECTROBUN_REF:-v1.13.1}"

echo "=== Building Electrobun Linux x64 core ==="
echo "Target ref:  $ELECTROBUN_REF"
echo "Submodule:   $SUBMODULE"
echo "Output:      $TARBALL"

# Refuse to run anywhere but ubuntu-22.04 unless explicitly overridden.
# A glibc 2.39 host produces a libNativeWrapper.so that needs glibc 2.39 — the
# whole point of this script is to avoid that.
if [ "${ALLOW_NON_2204:-0}" != "1" ]; then
  if [ -r /etc/os-release ]; then
    . /etc/os-release
    if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "22.04" ]; then
      echo "::error::This script must run on ubuntu-22.04 (got ${ID:-?} ${VERSION_ID:-?})"
      echo "Set ALLOW_NON_2204=1 to override (will produce a higher glibc floor)."
      exit 1
    fi
  else
    echo "::error::Not Linux — cannot build .so for Linux"
    exit 1
  fi
fi

# Sanity-check prerequisites
for bin in bun g++ pkg-config curl tar; do
  command -v "$bin" >/dev/null || { echo "::error::Missing prerequisite: $bin"; exit 1; }
done

# Required apt packages (Electrobun's own list, plus xz for tar)
REQUIRED_PKGS="build-essential cmake pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libfuse2 xz-utils"
MISSING=""
for pkg in $REQUIRED_PKGS; do
  dpkg -l "$pkg" 2>/dev/null | grep -q '^ii' || MISSING="$MISSING $pkg"
done
if [ -n "$MISSING" ]; then
  echo "Installing missing apt packages:$MISSING"
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y $MISSING
fi

# Verify submodule exists
if [ ! -d "$PKG_DIR" ]; then
  echo "::error::modules/electrobun submodule missing — run 'git submodule update --init modules/electrobun'"
  exit 1
fi

# Pin submodule to the requested ref (does NOT mutate parent repo's pointer)
echo "--- Checking out $ELECTROBUN_REF in submodule ---"
git -C "$SUBMODULE" fetch --tags origin
git -C "$SUBMODULE" checkout --detach "$ELECTROBUN_REF"

# Run electrobun's own build (downloads zig, CEF, builds everything for current platform)
echo "--- Running electrobun build (this can take 10+ minutes; pulls CEF ~1GB) ---"
cd "$PKG_DIR"
bun install --frozen-lockfile || bun install
bun build.ts

# After the build, the artifacts live in package/dist-linux-x64/
DIST="$PKG_DIR/dist-linux-x64"
if [ ! -d "$DIST" ]; then
  echo "::error::Expected $DIST after build — electrobun layout may have changed"
  ls "$PKG_DIR" | grep -i dist || true
  exit 1
fi

# Verify the critical files exist + report glibc footprint
echo "--- Built artifacts ---"
fail=0
for f in launcher extractor libNativeWrapper.so libNativeWrapper_cef.so libasar.so; do
  src="$DIST/$f"
  if [ ! -f "$src" ]; then
    echo "  MISSING: $f"
    fail=1
    continue
  fi
  # `|| true` because grep returns 1 when a binary has no GLIBC_ symbols
  # (e.g. statically linked Zig binaries like `launcher`/`extractor`), and
  # the script-level `set -euo pipefail` would otherwise kill us before we
  # could finish reporting. Empty max is the legitimate "none" case.
  max=$(strings "$src" 2>/dev/null | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -V | uniq | tail -1 || true)
  printf "  %-30s %s\n" "$f" "${max:-(none)}"
done
[ "$fail" = "0" ] || exit 1

# Stage + tar
echo "--- Packaging tarball ---"
mkdir -p "$OUTPUT_DIR"
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

for f in launcher extractor libNativeWrapper.so libNativeWrapper_cef.so libasar.so; do
  cp "$DIST/$f" "$STAGING/$f"
done

# Optional: include bun if upstream packed it here (it's downloaded separately by the
# CLI on first run, so not strictly required, but bundling keeps reproducibility tight).
if [ -f "$DIST/bun" ]; then
  cp "$DIST/bun" "$STAGING/bun"
fi

tar -czf "$TARBALL" -C "$STAGING" .
echo "Built: $TARBALL ($(du -h "$TARBALL" | cut -f1))"

# Final sanity report
echo ""
echo "=== Final glibc audit of tarball contents ==="
for f in "$STAGING"/*; do
  bn=$(basename "$f")
  max=$(strings "$f" 2>/dev/null | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -V | uniq | tail -1 || true)
  printf "  %-30s %s\n" "$bn" "${max:-(none)}"
done
