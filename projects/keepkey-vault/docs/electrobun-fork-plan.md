# Electrobun Fork Plan

Decision document for forking Electrobun and bringing it under KeepKey
source control. Written during the v1.2.5 Windows installer investigation.

Status: DRAFT -- awaiting second opinion before any action.

---

## Why Fork

### Current State

Electrobun is consumed as `electrobun@1.13.1` from npm. We already:

- Patch it at `postinstall` (`scripts/patch-electrobun.sh`) for the zip
  ENOBUFS bug
- Route around its native updater (PRs #39, #41 redirect to GitHub releases)
- Work around broken Windows behaviors documented in 33 quirks
- Cannot audit or control the Windows update mechanism (update.bat +
  scheduled tasks) that likely caused the v1.2.5 poison installer

### What We Need

1. Control over Windows installer/update behavior
2. Ability to fix bugs without waiting on upstream
3. Reproducible builds from source we audit
4. Stop patching opaque npm internals at postinstall time

---

## What to Fork

Repository: https://github.com/aspect-build/electrobun (or current upstream)

### Critical Components (must own)

| Component | File | Why |
|-----------|------|-----|
| Updater | `api/bun/core/Updater.ts` | update.bat, scheduled tasks, no rollback |
| CLI build | `src/cli/index.ts` | Windows packaging, rcedit, zip, bundle |
| Self-extractor | `dist-win-x64/extractor` | Zig binary, tar.zst decompression |
| Launcher | `dist-win-x64/launcher` | Process tree, WebView2 init |

### Non-Critical (can track upstream)

| Component | File | Why |
|-----------|------|-----|
| macOS launcher | `dist-macos-arm64/launcher` | Working fine |
| RPC system | `api/bun/core/RPC.ts` | Stable, well-understood |
| View bridge | `api/browser/` | Stable |

---

## Integration Options

### Option A: Git Submodule

```
modules/electrobun/          <- git submodule
  src/cli/index.ts           <- our patches
  api/bun/core/Updater.ts    <- our patches
```

Pros:
- Same pattern as hdwallet, proto-tx-builder, device-protocol
- Clear version pinning via submodule commit
- Full source audit

Cons:
- Zig compilation required for native binaries (extractor, launcher)
- Need Zig toolchain in CI
- Larger repo checkout

### Option B: Vendored Fork (npm package from our GitHub)

Fork on GitHub, publish as `@keepkey/electrobun` (or unpublished, reference
via git URL in package.json).

Pros:
- Minimal repo structure change
- npm resolution handles it
- Can still track upstream via git remote

Cons:
- Less visible than submodule
- npm publish step required for changes
- Git URL deps can be fragile

### Option C: Vendored Source (copy into repo)

Copy only the files we need to patch into `vendor/electrobun/`.

Pros:
- Simplest
- No submodule, no npm publish
- Only carries what we modify

Cons:
- Manual sync with upstream
- Partial copy can drift
- Build system must know to use vendored files

### Recommendation

**Option A (submodule)** -- consistent with existing patterns, gives us full
source control, and the Zig toolchain is already needed for
`wrapper-launcher.zig`.

---

## Specific Fixes Needed in Fork

### 1. Windows Updater: Add Rollback

Current: `rmdir` old app, then `move` new app. If move fails, no app exists.

Fix:
```bat
:: Rename old app as backup instead of deleting
rename "%RUNNING_APP%" "%RUNNING_APP%.backup"

:: Move new app
move "%NEW_APP%" "%RUNNING_APP%"
if errorlevel 1 (
    :: Rollback: restore backup
    rename "%RUNNING_APP%.backup" "%RUNNING_APP%"
    exit /b 1
)

:: Success: delete backup
rmdir /s /q "%RUNNING_APP%.backup"
```

### 2. Windows Updater: Process Kill

Current: Polls `tasklist` for `launcher.exe` in a loop.

Fix: Also kill `bun.exe` and `msedgewebview2.exe` processes associated with
the app, with a timeout and force-kill fallback.

### 3. Windows Updater: Scheduled Task Cleanup

Current: `for /f` loop with `findstr` that doesn't reliably parse task names.

Fix: Use PowerShell one-liner instead of batch parsing:
```bat
powershell -NoProfile -Command "Get-ScheduledTask | Where-Object {$_.TaskName -like 'ElectrobunUpdate_*'} | Unregister-ScheduledTask -Confirm:$false"
```

### 4. Windows Updater: File Lock Retry

Current: 2-second fixed delay after launcher exits.

Fix: Retry loop with exponential backoff (1s, 2s, 4s) checking if target
directory can be renamed. Give up after 30s with error logged.

### 5. Disable Electrobun's Native Updater

Since we've already routed updates through GitHub releases (PR #41), the
Electrobun updater should be completely disabled to prevent conflicts:

```typescript
// In fork: make updater a no-op unless explicitly enabled
if (!process.env.ELECTROBUN_NATIVE_UPDATE) {
    return; // Skip all update checks
}
```

### 6. Inno Setup Integration (our side, not fork)

Add to `installer.iss`:

```ini
[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\sh.keepkey.vault"
Type: filesandordirs; Name: "{localappdata}\com.keepkey.vault"

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Get-ScheduledTask | Where-Object {{$_.TaskName -like 'ElectrobunUpdate_*'}} | Unregister-ScheduledTask -Confirm:$false"""; Flags: runhidden

[Code]
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  // Kill running KeepKey Vault processes before install
  Exec('taskkill', '/im KeepKeyVault.exe /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill', '/im launcher.exe /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill', '/im bun.exe /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
end;
```

---

## Build System Changes

If we fork:

1. Add `modules/electrobun` to `.gitmodules`
2. Makefile target: `make electrobun-build` (Zig compile for platform binaries)
3. `package.json`: change `"electrobun": "1.13.1"` to `"electrobun": "file:../../modules/electrobun"`
4. Remove `postinstall` patch script
5. CI: install Zig toolchain (already needed for wrapper-launcher)

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Upstream diverges significantly | Medium | Track upstream as git remote, periodic merge |
| Zig toolchain breaks | Low | Pin Zig version, test in CI |
| Build time increases | Low | Only rebuild Zig binaries when source changes |
| Miss upstream security fix | Medium | Watch upstream releases, merge security patches |
| Fork maintenance burden | Medium | Only patch what we need, stay close to upstream |

---

## Timeline Considerations

- **Immediate (Track A)**: Fix `installer.iss` uninstall cleanup + publish
  unpoison guide. No fork needed.
- **Short-term (Track B)**: Fork Electrobun, fix updater, disable native
  update in favor of GitHub releases.
- **Medium-term**: Evaluate whether Electrobun is the right framework
  long-term or whether a simpler Bun+WebView2 wrapper would suffice.

---

## Decision Needed

Before proceeding:

1. Get second opinion on fork vs vendor vs stay-on-npm
2. Reproduce poison scenario on Windows VM
3. Validate that `installer.iss` cleanup fixes reinstall on contaminated machine
4. Decide if we disable Electrobun's native updater entirely or fix it
