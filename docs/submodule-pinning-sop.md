# Submodule Pinning SOP — KeepKey Vault v11

## Overview

The Vault release build depends on 4 git submodules under `modules/`. Each must
be pinned to a known-good commit on a well-defined branch before any release
branch is cut. Drift between submodule state and the pinned commit is the #1
source of "works on my machine" build failures.

`modules/keepkey-firmware` is intentionally not a Vault release gate. It is used
for emulator and firmware development only; do not block desktop Vault releases
on its branch, nested submodules, or CI state.

## Submodule Inventory

| Module | Repo | Expected Branch | Purpose |
|--------|------|-----------------|---------|
| **hdwallet** | `keepkey/hdwallet` | `master` | HD wallet core + KeepKey adapter (lodash/rxjs removed) |
| **proto-tx-builder** | `BitHighlander/proto-tx-builder` | `main` | Cosmos/Thorchain/Maya TX builder (`@keepkey/proto-tx-builder`) |
| **device-protocol** | `keepkey/device-protocol` | `master` | Protobuf message definitions — **must match firmware release** |
| **electrobun** | `blackboardsh/electrobun` | `main` | Desktop framework fork/runtime used by Vault |

Ignored for Vault releases:

| Module | Repo | Purpose |
|--------|------|---------|
| **keepkey-firmware** | `BitHighlander/keepkey-firmware` | Emulator build and firmware test fixtures only. Ignore for Vault packaging/release gating. |

## Pre-Release Pinning Checklist

Run this BEFORE creating a `release/X.Y.Z` branch:

```bash
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11

# 1. Fetch Vault release-gated submodules only
for mod in modules/hdwallet modules/proto-tx-builder modules/device-protocol modules/electrobun; do
  git -C "$mod" fetch --all --prune 2>/dev/null || true
done

# 2. Check release-gated submodules
for mod in modules/hdwallet modules/proto-tx-builder modules/device-protocol modules/electrobun; do
  pinned=$(git ls-tree HEAD "$mod" | awk '{print substr($3,1,12)}')
  actual=$(cd "$mod" && git rev-parse --short=12 HEAD)
  branch=$(cd "$mod" && git branch --show-current 2>/dev/null || echo "detached")
  dirty=$(cd "$mod" && git status --porcelain | wc -l | tr -d ' ')
  match="OK"; [ "$pinned" != "$actual" ] && match="DRIFT"
  echo "$mod: [$match] pinned=$pinned actual=$actual branch=$branch dirty=$dirty"
done
```

**All release-gated modules must show `[OK]` and `dirty=0` before cutting a
release branch. Ignore `modules/keepkey-firmware` for Vault packaging.**

```bash
# 4. Verify CI is green on every pinned commit
echo ""
echo "=== CI Status on Pinned Commits ==="
declare -A REPOS=(
  ["modules/hdwallet"]="keepkey/hdwallet"
  ["modules/proto-tx-builder"]="BitHighlander/proto-tx-builder"
  ["modules/device-protocol"]="keepkey/device-protocol"
  ["modules/electrobun"]="blackboardsh/electrobun"
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
| BitHighlander/proto-tx-builder | Build & Test | Must pass |
| keepkey/device-protocol | **None** | No CI — validate manually (lib/ build) |
| blackboardsh/electrobun | Build and Release + CEF Check | Build must pass; CEF is informational |

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

### keepkey-firmware (ignored for Vault releases)

- Not a desktop Vault release gate.
- Do not run recursive firmware submodule checks during Vault release prep.
- Do not block Vault packaging on firmware branch, nested submodules, or firmware CI.
- Only initialize and validate this repo when building the emulator or changing firmware fixtures.

### electrobun (`main`)

- Pin to `blackboardsh/electrobun` `main`
- Verify: `cd modules/electrobun && git log --oneline origin/main -1`

## CRITICAL: Check for Upstream Fixes Before Release

**Lesson learned (2026-04-03):** hdwallet was pinned to `9b7b98af` while master
had moved to `92ea4dae` with critical transport fixes (Osmosis/Ethereum/Binance
message type registration). The vault shipped with a broken Osmosis address
derivation for months because the pin wasn't updated.

**Before every release, check every Vault release-gated submodule for commits
behind upstream:**

```bash
echo "=== Commits behind upstream ==="
for mod in modules/hdwallet modules/proto-tx-builder modules/device-protocol modules/electrobun; do
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

**If ANY release-gated submodule is behind, review the missing commits.** Bug fixes and
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
git submodule update --init modules/hdwallet modules/proto-tx-builder modules/device-protocol modules/electrobun
git submodule status
# No '+' prefix = pinned commit matches checkout
# '+' prefix = DRIFT — submodule is on a different commit than pinned
```

## Integration with Release Process

The release skill (`~/.claude/skills/keepkey-vault-release.md`) Step 1 (Pre-flight
Checks) must include the pinning checklist above. The release branch MUST NOT be
created until all release-gated submodules show `[OK]` and `dirty=0`.

### Release Branch Gate

Before `git checkout -b release/X.Y.Z develop`:

1. Run the pinning checklist (all OK, all clean)
2. **Run the upstream-behind check** — review and pull any bug fixes
3. Verify `device-protocol` is on upstream master (not alpha/feature branch)
4. Verify `electrobun` is on `main` HEAD
5. Verify `hdwallet` is on `master` with lodash/rxjs removal
6. Ignore `modules/keepkey-firmware` unless this release explicitly changes emulator/firmware fixtures
7. Run `make build-stable` to confirm build succeeds with current pins

### Post-Release

After release is published:
- Do NOT update submodule pins on the release branch
- Feature-branch submodule updates go to `develop` only
- If a hotfix requires a submodule change, document it in the release notes

## Current State (2026-05-13)

| Module | Pinned To | Branch | Status |
|--------|-----------|--------|--------|
| hdwallet | `d83a65c3` | `master` | Current vault pin |
| proto-tx-builder | `f12f8c39` | `main` | Current vault pin |
| device-protocol | `bf8646b8` | `master` | Current vault pin; generated `lib/` still must be present on the build machine |
| electrobun | `73519358` | `main` | Current vault pin |

Ignored for Vault release gating:

| Module | Pinned To | Status |
|--------|-----------|--------|
| keepkey-firmware | `11d97d40` | Emulator/firmware fixture repo only; do not block Vault release on it |
