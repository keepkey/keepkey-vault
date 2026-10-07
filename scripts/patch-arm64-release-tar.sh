#!/usr/bin/env bash
set -euo pipefail

archive="${1:?Usage: patch-arm64-release-tar.sh <app.tar.zst> <certified-core-dir> <entitlements> [macos-target]}"
core_dir="${2:?missing certified core directory}"
entitlements="${3:?missing entitlements path}"
macos_target="${4:-13.0}"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"

for binary in libasar.dylib zig-zstd bspatch libNativeWrapper.dylib; do
  test -f "$core_dir/$binary" || { echo "ERROR: certified core lacks $binary"; exit 1; }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
zstd -d "$archive" -o "$work/app.tar" --force
tar xf "$work/app.tar" -C "$work"
rm "$work/app.tar"
app="$(find "$work" -maxdepth 1 -name '*.app' -type d | head -1)"
test -n "$app" || { echo "ERROR: archive contains no application bundle"; exit 1; }

for binary in libasar.dylib zig-zstd bspatch libNativeWrapper.dylib; do
  destination="$(find "$app/Contents/MacOS" -type f -name "$binary" -print -quit)"
  test -n "$destination" || { echo "ERROR: app bundle lacks $binary"; exit 1; }
  cp "$core_dir/$binary" "$destination"
done

"$repo_root/scripts/audit-macos-bundle.sh" "$app" arm64 "$macos_target"
"$repo_root/scripts/sign-macos-app.sh" "$app" "$entitlements"
"$repo_root/scripts/audit-macos-bundle.sh" "$app" arm64 "$macos_target"
(cd "$work" && tar cf - "$(basename "$app")") | zstd -o "$archive" --force
echo "Patched and signed: $archive"
