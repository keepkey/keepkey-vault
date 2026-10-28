#!/usr/bin/env bash
# Regenerate a release's checksum files from the bytes it actually serves:
# SHA256SUMS.txt (every shippable file) and SHA256SUMS-macos.txt (macOS only).
# Checks every line against GitHub's own asset digest, then uploads both.
#
# CI's SHA256SUMS.txt is written before the Intel bundle is re-signed, so its
# x64 line is always stale; v1.6.3, v1.6.5 and v1.6.6 shipped that way.
# `make sign-release-intel` runs this; run it again after the Windows installer
# is uploaded.
#
# usage: [DRY_RUN=1] scripts/release-sums.sh <tag> [owner/repo]
set -euo pipefail
TAG=$1
REPO=${2:-keepkey/keepkey-vault}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Drafts have no tag yet, so find the release by tag_name in the list.
gh api "repos/$REPO/releases" --paginate \
  --jq ".[] | select(.tag_name==\"$TAG\") | .assets[] | \"\(.digest // \"\" | sub(\"sha256:\";\"\"))  \(.name)\"" \
  > "$WORK/digests"
NAMES=$(awk '{print $2}' "$WORK/digests" | grep -E '\.(dmg|exe|AppImage|deb)$|^stable-.*\.(tar\.zst|tar\.gz)$' | sort)
test -n "$NAMES" || { echo "ERROR: no shippable assets on $TAG"; exit 1; }

for name in $NAMES; do
  for attempt in 1 2 3; do
    gh release download "$TAG" --repo "$REPO" --pattern "$name" --dir "$WORK/files" --clobber && break
    [ "$attempt" = 3 ] && { echo "ERROR: could not download $name"; exit 1; }
    sleep $((attempt * 5))
  done
done
(cd "$WORK/files" && shasum -a 256 $NAMES > ../SHA256SUMS.txt)
grep -E '\.dmg$|stable-macos-' "$WORK/SHA256SUMS.txt" > "$WORK/SHA256SUMS-macos.txt"

# The downloaded bytes must hash to GitHub's digest before anything is published.
bad=0
while read -r hash name; do
  grep -qxF "$hash  $name" "$WORK/digests" || { echo "MISMATCH: $name"; bad=1; }
done < "$WORK/SHA256SUMS.txt"
test "$bad" = 0 || { echo "ERROR: downloaded bytes do not match GitHub's asset digests; nothing uploaded"; exit 1; }

if [ -n "${DRY_RUN:-}" ]; then cat "$WORK/SHA256SUMS.txt"; echo "DRY_RUN: verified, nothing uploaded"; exit 0; fi
gh release upload "$TAG" --repo "$REPO" --clobber "$WORK/SHA256SUMS.txt" "$WORK/SHA256SUMS-macos.txt"
echo "SHA256SUMS.txt ($(wc -l < "$WORK/SHA256SUMS.txt" | tr -d ' ') files) and SHA256SUMS-macos.txt uploaded to $TAG; all match GitHub's digests"
