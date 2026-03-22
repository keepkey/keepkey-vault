# Release 1.2.6 "The Antidote" -- Plan

Working plan for the v1.2.6 release that fixes the Windows installer poisoning
introduced by v1.2.5. This is the actionable counterpart to
`windows-release-cycle-2026-03.md` (incident record) and
`electrobun-fork-plan.md` (long-term strategy).

Status: DRAFT -- documenting only, no code changes yet.

---

## Release State as of 2026-03-21

### GitHub Releases

| Version | Status | Notes |
|---------|--------|-------|
| v1.2.5 | Pre-release (LIVE) | Poison Windows installer shipped |
| v1.2.4 | Pre-release | |
| v1.2.3 | Pre-release | |
| v1.2.2 | Pre-release | EVM clear-signing |
| v1.1.2 | Latest (stable) | Last known-good stable |

v1.2.5 is pre-release, not marked Latest. v1.1.2 is still the stable release.

**Action needed**: Consider marking v1.2.5 as Draft to prevent further
downloads of the poisoned Windows installer, or at minimum pull the
`KeepKey-Vault-1.2.5-win-x64-setup.exe` asset.

### v1.2.5 Artifacts

- `KeepKey-Vault-1.2.5-arm64.dmg` (macOS)
- `KeepKey-Vault-1.2.5-win-x64-setup.exe` (POISONED)
- `KeepKey-Vault-x86_64.AppImage` (Linux)
- SHA256SUMS.txt
- Electrobun update artifacts (stable-linux, stable-macos)

---

## Open PRs to Resolve

### PR #43 -- CRITICAL (must land for 1.2.6)

**Title**: fix: defer engine init + fix SQLite never working on Windows
**Head**: `fix/lazy-load-swagger-defer-engine`
**Base**: `feature/windows-startup-optimization` (NOT develop)
**State**: OPEN
**Commits**: 3

**Contains**:
1. Deferred backend initialization (window appears 500ms faster)
2. SQLite BOM fix (PowerShell 5 writes BOM into version.json, breaks all
   Windows data persistence since v1.0)
3. Performance timestamps for boot diagnostics
4. File logger for Windows debugging

**Problem**: PR targets `feature/windows-startup-optimization`, which itself
targets... unclear. Neither branch exists on any remote. The PR is orphaned
from the current branch topology.

**Resolution options**:
1. Close PR #43, cherry-pick the 3 commits onto `release-cycle` (cleanest)
2. Create `feature/windows-startup-optimization` from develop, rebase PR #43
   onto it, merge both to develop
3. Retarget PR #43 directly to develop

**Recommendation**: Option 1. Cherry-pick the commits. The intermediate branch
adds no value.

### PR #42 -- CLOSED (superseded)

**Title**: fix: replace Windows auto-update with GitHub redirect
**State**: CLOSED (superseded by PR #41 which was merged)

No action needed.

### PR #40 -- CLOSED (superseded)

**Title**: fix: macOS auto-update bypass + background pre-release check
**State**: CLOSED (superseded by PR #41)

No action needed.

### PR #37 -- CLOSED (superseded)

**Title**: fix: firmware vs bootloader reboot logging + bug doc
**State**: CLOSED (superseded by PR #36 which was merged)

No action needed.

---

## Remote Branches to Clean Up

### Merged branches (safe to delete)

These branches have merged PRs and can be deleted from origin:

| Branch | Merged PR |
|--------|-----------|
| `fix/macos-update-open-releases` | PR #41 |
| `fix/auto-update-github-api` | PR #39 |
| `fix/zig-015-drawtext-compat` | PR #38 |
| `fix/bootloader-reboot-disconnect-messaging` | PR #36 |
| `fix/windows-auto-update` | PR #32 (to develop) |
| `fix/bootloader-reboot-messaging` | PR #33 |
| `fix/pin-overlay-api-signing` | PR #30 |
| `feature-api-docs` | PR #29 |
| `fix/oob-bootloader-reconnect-prompt` | PR #28 |
| `fix/windows-splash-and-signing` | PR #27 |
| `fix/windows-onboarding` | PR #25 |
| `fix/windows-zcash-signing-and-docs` | PR #22 |
| `feature/incorrect-pin-ui` | PR #34 |
| `feature/activity-tracker` | PR #18 |
| `feature/spl-token-support` | PR #19 |
| `features-714c` | PR #21 |
| `fix/zcash-ak-sign-bit` | PR #20 |

### Superseded branches (safe to delete)

| Branch | Superseded By |
|--------|---------------|
| `fix/revert-windows-auto-update` | PR #41 merged |
| `fix/macos-auto-update` | PR #41 merged |

### Stale release branches (evaluate)

| Branch | Notes |
|--------|-------|
| `release/1.0.1` through `release/1.2.3` | Old releases, keep for history or delete |
| `release/7.14.0` | Unclear purpose |
| `release/1.1.2-win` | Windows-specific release branch |
| `hotfix/windows` | Stale |
| `hotfix/windows-1.0.2` | Stale |

### Legacy branches (probably safe to delete)

Dozens of pre-v1.0 branches exist on all three remotes (origin, public,
upstream): `3864-eip-1559-fees`, `add-1559-access-list`, `cosmos-refactor`,
`stellar`, etc. These are from the old SDK era and likely irrelevant.

---

## What Must Be in 1.2.6

### Track A: Installer antidote (minimum viable fix)

1. **`installer.iss` hardening**
   - `[UninstallDelete]` for `%LOCALAPPDATA%\sh.keepkey.vault`
   - `[UninstallDelete]` for `%LOCALAPPDATA%\com.keepkey.vault`
   - `[UninstallRun]` to remove `ElectrobunUpdate_*` scheduled tasks
   - `[Code]` preflight to kill running processes before install
   - `[InstallDelete]` for stale Electrobun state (repair path)

2. **PR #43 cherry-picks**
   - Deferred backend init
   - SQLite BOM fix
   - Boot diagnostics

3. **Version bump** to 1.2.6

### Track B: Framework control (deferred, needs second opinion)

- Electrobun fork decision
- Disable Electrobun's native updater
- Updater.ts rollback mechanism

---

## What Should NOT Be in 1.2.6

This is a targeted antidote release. Do not include:

- New features
- Chain additions
- UI redesigns
- Dependency upgrades beyond what's needed for the fix
- Electrobun fork (Track B -- separate release)

---

## Validation Checklist

Before shipping 1.2.6, verify on Windows:

1. Fresh install on clean Windows 10 VM -> launch -> works
2. Fresh install on clean Windows 11 VM -> launch -> works
3. Install on poisoned machine (from 1.2.5) WITHOUT manual cleanup -> works
4. Install on poisoned machine AFTER manual cleanup -> works
5. Uninstall 1.2.6 -> verify no residue in:
   - `%LOCALAPPDATA%\Programs\KeepKeyVault`
   - `%LOCALAPPDATA%\sh.keepkey.vault`
   - `%LOCALAPPDATA%\com.keepkey.vault`
   - Scheduled tasks
6. Reinstall after uninstall -> works
7. macOS build not broken by Windows changes

Use `windows-antidote-evidence-guide.md` for evidence collection procedure.

---

## Working Order

1. Mark v1.2.5 as Draft (or pull Windows .exe asset)
2. Close or retarget PR #43
3. Cherry-pick PR #43 commits onto `release-cycle`
4. Implement installer.iss antidote changes
5. Clean up merged/superseded remote branches
6. Build and test on Windows VM
7. Version bump to 1.2.6
8. Ship as pre-release, validate with antidote evidence guide
9. Promote to Latest once validated

---

## Branch Topology for 1.2.6

```
develop (c42cb81)
  |
  +-- release-cycle (documentation, this branch)
        |
        +-- (cherry-pick PR #43 commits)
        +-- (installer.iss antidote)
        +-- (version bump)
        |
        +-- release/1.2.6 (cut when ready to ship)
```

---

## Files to Modify

| File | Change |
|------|--------|
| `scripts/installer.iss` | Add uninstall cleanup, preflight kill, install-time repair |
| `src/bun/index.ts` | Cherry-pick: deferred init, BOM fix |
| `package.json` | Version bump to 1.2.6 |
| `electrobun.config.ts` | Version bump to 1.2.6 |
