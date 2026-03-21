# Retro: Windows Auto-Update — Revert to GitHub Redirect

**Date**: 2026-03-21
**Decision**: Remove in-app auto-update on Windows, redirect users to GitHub releases page

## What happened

The Windows auto-update feature (introduced in v1.2.1–v1.2.3) downloads the Inno Setup
installer in the background, then spawns it via `cmd /c start` and calls `process.exit(0)`.

This creates a cascade of failures:

1. **Old app doesn't fully exit**: The bun process, launcher, and WebView2 hold file locks
   on DLLs, the WebView2 user data folder, and the install directory. `process.exit(0)` kills
   the JS runtime but the native WebView2 host process lingers.

2. **Installer can't replace locked files**: The Inno Setup installer tries to overwrite
   `libNativeWrapper.dll`, `bun.exe`, `launcher.exe`, etc. while they're still held open.
   This results in partial installs or silently skipped file replacements.

3. **Broken state persists across reboots**: After a failed auto-update, the installed app
   is in an inconsistent state. The WebView2 profile may reference assets that were partially
   replaced. The app launches (bun starts, launcher spawns) but `startEventLoop` in
   `libNativeWrapper.dll` hangs indefinitely — no window appears, no app.log output, nothing.

4. **Non-deterministic**: Sometimes the old process exits fast enough and the update works.
   Other times it doesn't. This makes the bug extremely hard to reproduce and diagnose.

## Timeline of auto-update commits

| Commit | Description | Problem introduced |
|--------|-------------|-------------------|
| `4037aa5` | Download/Install buttons in Settings | Initial auto-update UI |
| `c71539c` | Windows auto-update — download setup exe directly | `windowsDownloadAndInstall` + `windowsLaunchInstaller` |
| `2db676f` | Pre-release channel auto-update fix | Extended the broken pattern |

## Root cause

Windows does not allow replacing executables and DLLs that are memory-mapped by a running
process. Unlike macOS (where you can replace the .app bundle while running), Windows locks
every loaded binary. The only reliable way to update on Windows is:

1. User closes the app themselves
2. Installer runs with no locked files
3. App relaunches clean

## Decision

Replace the in-app download/install flow with a simple redirect:

- **"Update Available" banner**: Shows version, links to GitHub releases page
- **Settings panel**: Same — "Download from GitHub" button opens browser
- **No background download, no process.exit(), no installer spawn**

The user:
1. Sees "Update available v1.2.5"
2. Clicks "Download from GitHub"
3. Browser opens to `github.com/keepkey/keepkey-vault/releases/tag/v1.2.5`
4. User downloads installer, closes app, runs installer

This is the same pattern used by most desktop crypto wallets (Ledger Live, Trezor Suite)
for Windows updates.

## What we keep

- Update **checking** (compare version against GitHub releases) — still works
- macOS auto-update — not affected by this issue (macOS allows .app bundle replacement)
- Linux auto-update — not affected

## Files changed

| File | Change |
|------|--------|
| `src/bun/index.ts` | Remove `windowsDownloadAndInstall`, `windowsLaunchInstaller` |
| `src/mainview/components/UpdateBanner.tsx` | Replace Download/Install with GitHub link |
| `src/mainview/components/DeviceSettingsDrawer.tsx` | Replace Download/Install with GitHub link |
| `src/mainview/hooks/useUpdateState.ts` | Simplify — remove download/apply phases on Windows |
| `scripts/build-windows-production.ps1` | Fix UTF-8 BOM in version.json |
| `scripts/wrapper-launcher.zig` | Fix Zig 0.15.2 DrawTextW compat |

## Lessons learned

1. **Don't auto-update on Windows without a proper update framework** (NSIS silent update, Squirrel, WiX Burn). Spawning an installer while the app is running is fundamentally broken.
2. **The BOM bug** (`Set-Content -Encoding UTF8` in PowerShell 5 writes BOM) was a separate issue that compounded the debugging — always use `[System.IO.File]::WriteAllText()` for JSON files in PowerShell.
3. **The Zig 0.15.2 upgrade** broke the splash screen compile — `.ptr` is needed for sentinel-terminated to many-pointer coercion. Pin Zig version or test upgrades before release.
