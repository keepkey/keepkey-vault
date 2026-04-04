# Submodule Pinning SOP — KeepKey Vault v11

## Overview

The vault depends on 5 git submodules under `modules/`. Each must be pinned to a
known-good commit on a well-defined branch before any release branch is cut.
Drift between submodule state and the pinned commit is the #1 source of
"works on my machine" build failures.

## Submodule Inventory

| Module | Repo | Expected Branch | Purpose |
|--------|------|-----------------|---------|
| **hdwallet** | `keepkey/hdwallet` | `master` | HD wallet core + KeepKey adapter (lodash/rxjs removed) |
| **proto-tx-builder** | `BitHighlander/proto-tx-builder` | `main` | Cosmos/Thorchain/Maya TX builder (`@keepkey/proto-tx-builder`) |
| **device-protocol** | `keepkey/device-protocol` | `master` | Protobuf message definitions — **must match firmware release** |
| **keepkey-firmware** | `keepkey/keepkey-firmware` | `master` or `release/X.Y.Z` | Emulator build, test fixtures — pin to release tag for stability |
| **electrobun** | `BitHighlander/electrobun` | `keepkey/macos-12-support` | Desktop framework fork — **tech debt: not yet merged to main** |

## Pre-Release Pinning Checklist

Run this BEFORE creating a `release/X.Y.Z` branch:

```bash
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11

# 1. Fetch all remotes (top-level + nested)
git submodule foreach --recursive 'git fetch --all --prune 2>/dev/null || true'

# 2. Check top-level submodules
for mod in modules/hdwallet modules/proto-tx-builder modules/keepkey-firmware modules/device-protocol modules/electrobun; do
  pinned=$(git ls-tree HEAD "$mod" | awk '{print substr($3,1,12)}')
  actual=$(cd "$mod" && git rev-parse --short=12 HEAD)
  branch=$(cd "$mod" && git branch --show-current 2>/dev/null || echo "detached")
  dirty=$(cd "$mod" && git status --porcelain | wc -l | tr -d ' ')
  match="OK"; [ "$pinned" != "$actual" ] && match="DRIFT"
  echo "$mod: [$match] pinned=$pinned actual=$actual branch=$branch dirty=$dirty"
done

# 3. Check firmware nested submodules (deep tree — device-protocol, python-keepkey, trezor-firmware)
echo ""
echo "=== Firmware nested submodules ==="
drifted=$(cd modules/keepkey-firmware && git submodule status --recursive | grep '^+')
if [ -n "$drifted" ]; then
  echo "⚠️  DRIFTED nested submodules:"
  echo "$drifted"
  echo "Fix: cd modules/keepkey-firmware && git submodule update --init --recursive"
else
  echo "✅ All firmware nested submodules match pins"
fi
```

**All modules must show `[OK]` and `dirty=0`, and firmware nested submodules
must have no `+` prefix, before cutting a release branch.**

```bash
# 4. Verify CI is green on every pinned commit
echo ""
echo "=== CI Status on Pinned Commits ==="
declare -A REPOS=(
  ["modules/hdwallet"]="keepkey/hdwallet"
  ["modules/proto-tx-builder"]="BitHighlander/proto-tx-builder"
  ["modules/device-protocol"]="keepkey/device-protocol"
  ["modules/keepkey-firmware"]="keepkey/keepkey-firmware"
  ["modules/electrobun"]="BitHighlander/electrobun"
)
for mod in "${!REPOS[@]}"; do
  repo="${REPOS[$mod]}"
  sha=$(cd "$mod" && git rev-parse HEAD)
  # Check GitHub check-runs on the pinned commit
  result=$(gh api "repos/$repo/commits/$sha/check-runs" --jq '
    if .total_count == 0 then "⚠️  NO CI"
    elif ([.check_runs[] | select(.conclusion == "failure")] | length) > 0 then "❌ FAILED: " + ([.check_runs[] | select(.conclusion == "failure") | .name] | join(", "))
    elif ([.check_runs[] | select(.conclusion == "success")] | length) == .total_count then "✅ ALL GREEN"
    else "⏳ PENDING: " + ([.check_runs[] | select(.conclusion != "success") | "\(.name):\(.status)"] | join(", "))
    end' 2>/dev/null || echo "⚠️  API error")
  echo "$mod ($repo): $result"
done
```

**CI gate rules:**
- ✅ ALL GREEN: proceed
- ⏳ PENDING: wait for completion
- ❌ FAILED: STOP — do not release with failing CI on any submodule
- ⚠️ NO CI: acceptable for repos without workflows (device-protocol), but
  flag it in release notes

**Current CI coverage:**

| Repo | Workflows | Notes |
|------|-----------|-------|
| keepkey/hdwallet | CI (build matrix) | Must pass |
| keepkey/keepkey-firmware | CI + Zoo Report | CI must pass; Zoo is informational |
| BitHighlander/proto-tx-builder | Build & Test | Must pass |
| keepkey/device-protocol | **None** | No CI — validate manually (lib/ build) |
| BitHighlander/electrobun | Build and Release + CEF Check | Build must pass; CEF is informational |

## Per-Module Rules

### hdwallet (`master`)

- Must be on `master` HEAD (or a tagged release)
- The `master` branch must have the lodash/rxjs removal commit (`179c5668`)
- If pinning to a feature branch, the branch MUST be merged to `master` before release
- Verify: `cd modules/hdwallet && git branch -r --contains HEAD | grep master`

### proto-tx-builder (`main`)

- Must be on `main` HEAD
- Single-branch repo, straightforward
- Verify: `cd modules/proto-tx-builder && git log --oneline origin/main -1`

### device-protocol (`master`)

- **Must be synced to upstream `keepkey/device-protocol` master before release**
- The protocol version must match the firmware version being targeted
- If a new firmware release adds proto messages, those must be merged to master first
- The `lib/` directory is gitignored — must be pre-built before vault builds
- Verify: `cd modules/device-protocol && git log --oneline origin/master..HEAD` (should be empty)
- If ahead of master: merge or rebase to master, push, then re-pin

### keepkey-firmware (`master` or `release/X.Y.Z`)

- Pin to `master` HEAD for general development
- Pin to a `release/X.Y.Z` tag/branch when the vault targets a specific firmware
- **Has 7 nested submodules** (device-protocol, trezor-firmware, python-keepkey,
  googletest, code-signing-keys, QR-Code-generator, SecAESSTM32)
- python-keepkey itself has 2 nested submodules (device-protocol, ethereum-lists)
- After any firmware pin change, run `cd modules/keepkey-firmware && git submodule update --init --recursive`
- Verify: `cd modules/keepkey-firmware && git submodule status --recursive | grep '^+'` (should be empty — `+` means drift)

### electrobun (`keepkey/macos-12-support`)

**This is tech debt.** The fork has macOS 12/Intel support patches that have NOT
been merged to `main`. The branch diverged from `main` and both have moved forward
independently.

- Pin to `keepkey/macos-12-support` branch HEAD
- This branch contains: macOS 12 Monterey + Intel Mac support, resign-swizzle removal
- `main` has: GPU screenshot readback, Bun 1.3.11 bump, WGPU cleanup
- **Action item**: Merge `main` into `keepkey/macos-12-support` (or vice versa) to
  reduce divergence. Until then, this branch is required for Intel Mac builds.
- Verify: `cd modules/electrobun && git log --oneline origin/keepkey/macos-12-support -1`

## CRITICAL: Check for Upstream Fixes Before Release

**Lesson learned (2026-04-03):** hdwallet was pinned to `9b7b98af` while master
had moved to `92ea4dae` with critical transport fixes (Osmosis/Ethereum/Binance
message type registration). The vault shipped with a broken Osmosis address
derivation for months because the pin wasn't updated.

**Before every release, check ALL submodules for commits behind upstream:**

```bash
echo "=== Commits behind upstream ==="
for mod in modules/hdwallet modules/proto-tx-builder modules/device-protocol modules/keepkey-firmware modules/electrobun; do
  branch=$(cd "$mod" && git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}')
  [ -z "$branch" ] && branch="master"
  (cd "$mod" && git fetch origin "$branch" 2>/dev/null)
  behind=$(cd "$mod" && git rev-list --count HEAD..origin/"$branch" 2>/dev/null)
  if [ "$behind" -gt 0 ]; then
    echo "⚠️  $mod: $behind commits behind origin/$branch"
    (cd "$mod" && git log --oneline HEAD..origin/"$branch")
  else
    echo "✅ $mod: up to date with origin/$branch"
  fi
  echo ""
done
```

**If ANY submodule is behind, review the missing commits.** Bug fixes and
transport/protocol changes MUST be pulled before release. Feature commits
can be deferred if they introduce risk.

**This check is separate from the pinning check.** A submodule can show `[OK]`
(pinned commit matches checkout) while being behind upstream (pinned to an
old commit). Both checks must pass.

## How to Re-Pin a Submodule

```bash
# 1. Enter the submodule and checkout the desired commit/branch
cd modules/<name>
git checkout <branch>
git pull

# 2. Return to vault root and stage the new pin
cd ../..
git add modules/<name>
git commit -m "chore: pin <name> to <branch> HEAD (<short-hash>)"
```

## How to Verify Pinning After Checkout

```bash
git submodule update --init --recursive
git submodule status
# No '+' prefix = pinned commit matches checkout
# '+' prefix = DRIFT — submodule is on a different commit than pinned
```

## Integration with Release Process

The release skill (`~/.claude/skills/keepkey-vault-release.md`) Step 1 (Pre-flight
Checks) must include the pinning checklist above. The release branch MUST NOT be
created until all submodules show `[OK]` and `dirty=0`.

### Release Branch Gate

Before `git checkout -b release/X.Y.Z develop`:

1. Run the pinning checklist (all OK, all clean)
2. **Run the upstream-behind check** — review and pull any bug fixes
3. Verify `device-protocol` is on upstream master (not alpha/feature branch)
4. Verify `keepkey-firmware` pin matches the firmware version being shipped
5. Verify `electrobun` is on `keepkey/macos-12-support` HEAD
5. Verify `hdwallet` is on `master` with lodash/rxjs removal
6. Run `make build-stable` to confirm build succeeds with current pins

### Post-Release

After release is published:
- Do NOT update submodule pins on the release branch
- Feature-branch submodule updates go to `develop` only
- If a hotfix requires a submodule change, document it in the release notes

## Current State (2026-04-03)

| Module | Pinned To | Branch | Status |
|--------|-----------|--------|--------|
| hdwallet | `9b7b98af` | `master` | OK — latest master |
| proto-tx-builder | `368987a9` | `main` | OK — latest main |
| device-protocol | `cb2e0a96` | alpha (detached) | OK — master has all required protocol messages; re-pin to master HEAD before next release |
| keepkey-firmware | `98fb2103` | detached | OK — release/v7.14.0 merge commit |
| electrobun | `4f3d422a` | `keepkey/macos-12-support` | OK — latest on branch (tech debt: not merged to main) |
