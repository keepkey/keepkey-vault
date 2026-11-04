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
| **hdwallet** | `keepkey/hdwallet` | `master` | HD wallet core + KeepKey adapter with certified signing metadata |
| **proto-tx-builder** | `BitHighlander/proto-tx-builder` | `main` | Cosmos/Thorchain/Maya TX builder (`@keepkey/proto-tx-builder`) |
| **device-protocol** | `keepkey/device-protocol` | `master` | Canonical protocol; hdwallet gets it from npm as `@bithighlander/device-protocol` |
| **electrobun** | `BitHighlander/electrobun` | `keepkey/launcher-env-uaf-fix` | Desktop framework (v1.18.1 + KeepKey launcher fixes). macOS launchers come from prebuilt cores, see below |

Ignored for Vault releases:

| Module | Repo | Purpose |
|--------|------|---------|
| **keepkey-firmware** | `BitHighlander/keepkey-firmware` | Firmware source and development fixtures. Never reconcile or re-pin it during a Vault release. The separately certified bundled emulator artifacts have their own gate. |

## Pre-Release Pinning Checklist

Run this BEFORE creating a `release/X.Y.Z` branch:

```bash
cd keepkey-stack/projects/keepkey-vault-v11

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
  ["modules/hdwallet"]="BitHighlander/hdwallet"
  ["modules/proto-tx-builder"]="BitHighlander/proto-tx-builder"
  ["modules/device-protocol"]="keepkey/device-protocol"
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
- ⚠️ NO CI: acceptable only for repos documented without workflows; it is not
  acceptable for `keepkey/device-protocol`

**Current CI coverage:**

| Repo | Workflows | Notes |
|------|-----------|-------|
| keepkey/hdwallet | CI (build matrix) | Must pass; the Vault contract suite is also blocking |
| BitHighlander/proto-tx-builder | none on the pin | Accepted (`PREFLIGHT_NO_CI_OK` in the Makefile). Vault CI builds it |
| keepkey/device-protocol | Protocol CI | Must pass; the exact pinned commit must be published |
| BitHighlander/electrobun | none on the pin | Accepted (`PREFLIGHT_NO_CI_OK`). Vault CI's Intel smoke test boots the packaged app |

## Per-Module Rules

### hdwallet (`keepkey/hdwallet` `master`)

- Pin to `keepkey/hdwallet` `master`, not the BitHighlander fork
- Must have the lodash/rxjs removal commit (`179c5668`)
- The exact pin must pass the Vault host/submodule contract suite
- Verify: `cd modules/hdwallet && git merge-base --is-ancestor HEAD origin/master`

### proto-tx-builder (`BitHighlander/proto-tx-builder` `main`)

- Must be on `main` HEAD
- Stay on the fork. `keepkey/proto-tx-builder` calls `createFeegrantAminoConverters`,
  which the `@cosmjs/stargate` 0.28.13 shipped in the app does not export (it is
  misspelled "Freegrant"); the fork's `f12f8c3` falls back. Upstream passes unit
  tests but breaks every Cosmos/THORChain/Maya/Osmosis signature in the packaged
  app. Moving upstream needs that fallback upstream first.
- Verify: `cd modules/proto-tx-builder && git log --oneline origin/main -1`

### device-protocol (`master`)

- **Must come from `keepkey/device-protocol` `master`**
- hdwallet depends on `npm:@bithighlander/device-protocol@<version>`, published
  from the pinned master commit with only the package name and version changed
- The generated protocol library must satisfy the Vault runtime contract
- Required protocol changes must be merged to `master` first
- The npm package must be built from the exact pinned commit (name and version changes only)
- The `lib/` directory is gitignored — it is built from the submodule (`make modules-build`) before vault builds
- Verify the remote first: `git submodule sync -- modules/device-protocol && git -C modules/device-protocol remote get-url origin`
- The remote must be `https://github.com/keepkey/device-protocol`
- Verify the branch: `cd modules/device-protocol && git fetch origin master && git log --oneline origin/master..HEAD` (should be empty)
- Verify publication: the npm package's `lib/` and protos must equal a build of
  the pinned commit; only `name` and `version` in `package.json` may differ.

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

### electrobun (`BitHighlander/electrobun` `keepkey/launcher-env-uaf-fix`)

- Pin to `keepkey/launcher-env-uaf-fix` (v1.18.1 + 4 launcher fixes). In a local
  clone `origin` may be upstream blackboardsh; the fork is a separate remote.
- macOS launchers do NOT come from this pin: arm64 uses the certified core in
  `emulator-bundle/manifest.json`, Intel uses `electrobun-x64-core-v7`
  (`X64_CORE_TAG` in build.yml). The pin builds Linux and Windows.
- Before publishing a new Intel core (`make publish-electrobun-x64-core`), merge
  `af641fab` ("avoid Intel macOS path join crash", on `launcher-env-lifetime`)
  into the pinned branch: without it Zig 0.13 miscompiles the launcher for x86_64.
- Upstream is now v2 (launcher rewritten); moving there is a migration, not a re-pin.

## CRITICAL: Check for Upstream Fixes Before Release

**Lesson learned (2026-04-03):** hdwallet was pinned to `9b7b98af` while master
had moved to `92ea4dae` with critical transport fixes (Osmosis/Ethereum/Binance
message type registration). The vault shipped with a broken Osmosis address
derivation for months because the pin wasn't updated.

**Before every release, check every Vault release-gated submodule for commits
behind upstream:**

```bash
echo "=== Commits behind canonical branches ==="
for pair in \
  "modules/hdwallet|master" \
  "modules/proto-tx-builder|main" \
  "modules/device-protocol|master" \
  "modules/electrobun|keepkey/launcher-env-uaf-fix"; do
  mod=${pair%%|*}
  branch=${pair##*|}
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
3. Verify `device-protocol` is on `keepkey/device-protocol` master and that hdwallet's `@bithighlander/device-protocol` version was built from it
4. Verify `electrobun` is on the configured BitHighlander release branch HEAD
5. Verify `hdwallet` is on the configured BitHighlander release branch HEAD
6. Do not inspect or modify `modules/keepkey-firmware`.
7. Run the bundled emulator artifact gate in `docs/emulator-release-sop.md`.
8. Run `make build-stable` to confirm build succeeds with current runtime pins.

### Post-Release

After release is published:
- Do NOT update submodule pins on the release branch
- Feature-branch submodule updates go to `develop` only
- If a hotfix requires a submodule change, document it in the release notes

## Current State (2026-10-28, v1.6.7)

| Module | Pinned To | Branch | Status |
|--------|-----------|--------|--------|
| hdwallet | `b9dadcfd` | keepkey `master` | head of master, CI 5/5 |
| proto-tx-builder | `f12f8c39` | BitHighlander `main` | fork kept (see above), no CI |
| device-protocol | `bd340910` | keepkey `master` | head of master, CI 10/10; npm `@bithighlander/device-protocol@7.20.0` byte-identical except name/version |
| electrobun | `7a9bc757` | BitHighlander `keepkey/launcher-env-uaf-fix` | no CI; Intel core v7 separate |

`make preflight` runs every check in this document; it must end with
"ALL GATES PASSED".

`modules/keepkey-firmware` is intentionally omitted. Its pin is not inventory
for a Vault release and must not be changed by this SOP.
