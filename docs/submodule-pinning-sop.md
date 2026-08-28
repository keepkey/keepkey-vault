# Submodule Pinning SOP — KeepKey Vault v11

## Overview

The Vault release build depends on 4 git submodules under `modules/`. Each must
be pinned to a known-good commit on a well-defined branch before any release
branch is cut. Drift between submodule state and the pinned commit is the #1
source of "works on my machine" build failures.

`modules/keepkey-firmware` is intentionally not a Vault release gate. Do not
inspect, clean, checkout, reset, fetch, or re-pin it while preparing a Vault
release. Its branch, version, nested submodules, CI state, and gitlink drift are
outside the desktop release decision.

The emulator shipped inside Vault is a separate release artifact gate. A Vault
release must contain the approved `libkkemu` artifact set, but that requirement
never authorizes changing the firmware gitlink. See
[`docs/emulator-release-sop.md`](./emulator-release-sop.md).

## Submodule Inventory

| Module | Repo | Expected Branch | Purpose |
|--------|------|-----------------|---------|
| **hdwallet** | `keepkey/hdwallet` | `master` | HD wallet core + KeepKey adapter (lodash/rxjs removed) |
| **proto-tx-builder** | `BitHighlander/proto-tx-builder` | `main` | Cosmos/Thorchain/Maya TX builder (`@keepkey/proto-tx-builder`) |
| **device-protocol** | `BitHighlander/device-protocol` | `master` | Canonical Vault protocol fork and published `@bithighlander/device-protocol` package |
| **electrobun** | `blackboardsh/electrobun` | `main` | Desktop framework fork/runtime used by Vault |

Ignored for Vault releases:

| Module | Repo | Purpose |
|--------|------|---------|
| **keepkey-firmware** | `BitHighlander/keepkey-firmware` | Firmware source and development fixtures. Never reconcile or re-pin it during a Vault release. The separately certified bundled emulator artifacts have their own gate. |

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
release branch. Do not include `modules/keepkey-firmware` in this check.**

```bash
# 4. Verify CI is green on every pinned commit
echo ""
echo "=== CI Status on Pinned Commits ==="
declare -A REPOS=(
  ["modules/hdwallet"]="keepkey/hdwallet"
  ["modules/proto-tx-builder"]="BitHighlander/proto-tx-builder"
  ["modules/device-protocol"]="BitHighlander/device-protocol"
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
- ⚠️ NO CI: acceptable only for repos documented without workflows; it is not
  acceptable for `BitHighlander/device-protocol`

**Current CI coverage:**

| Repo | Workflows | Notes |
|------|-----------|-------|
| keepkey/hdwallet | CI (build matrix) | Must pass |
| BitHighlander/proto-tx-builder | Build & Test | Must pass |
| BitHighlander/device-protocol | Build & Publish + Protocol CI | Both validation jobs must pass; the exact fork commit must be published |
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

- **Must come from `BitHighlander/device-protocol` fork `master`**
- **Never reconcile, merge, publish, or gate against `keepkey/device-protocol`**
- The generated protocol library must satisfy the Vault runtime contract
- Required protocol changes must be merged to the fork `master` first
- The package must be published as `@bithighlander/device-protocol` from the exact pinned fork commit
- The `lib/` directory is gitignored — must be pre-built before vault builds
- Verify the remote first: `git submodule sync -- modules/device-protocol && git -C modules/device-protocol remote get-url origin`
- The remote must be `https://github.com/BitHighlander/device-protocol`
- Verify the fork branch: `cd modules/device-protocol && git fetch origin master && git log --oneline origin/master..HEAD` (should be empty)
- Verify publication: fork tag `v<version>` must resolve to the pinned commit,
  the registry repository must be the BitHighlander fork, and a local dry-run
  pack from the pinned commit must match the registry `dist.integrity`. If npm
  records `gitHead`, it must also equal the pinned commit.

### keepkey-firmware (ignored for Vault releases)

- Not a desktop Vault release gate.
- Do not run firmware status, version, branch, behind/ahead, CI, or recursive
  nested-submodule checks during Vault release prep.
- Never checkout, reset, clean, fetch, merge, or re-pin this submodule to make a
  Vault release pass.
- A missing or incorrect bundled emulator stops the Vault release at the
  emulator artifact gate; it is not repaired by changing this gitlink.
- Firmware changes and emulator artifact production happen in their own
  workflow, outside the Vault release procedure.

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
echo "=== Commits behind canonical branches ==="
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
2. **Run the canonical-branch-behind check** — review and pull any bug fixes
3. Verify `device-protocol` is on `BitHighlander/device-protocol` fork master and that the exact commit is published as `@bithighlander/device-protocol`
4. Verify `electrobun` is on `main` HEAD
5. Verify `hdwallet` is on `master` with lodash/rxjs removal
6. Do not inspect or modify `modules/keepkey-firmware`.
7. Run the bundled emulator artifact gate in `docs/emulator-release-sop.md`.
8. Run `make build-stable` to confirm build succeeds with current runtime pins.

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

`modules/keepkey-firmware` is intentionally omitted. Its pin is not inventory
for a Vault release and must not be changed by this SOP.
