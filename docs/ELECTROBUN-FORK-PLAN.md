# Electrobun Fork Plan

**Date**: 2026-03-22
**Decision**: Fork electrobun, build from source, own the Windows story

## Why We're Forking

We've spent 15+ hours fighting electrobun's Windows support because:

1. **We don't control the binaries we ship.** `electrobun build` downloads pre-built
   `libNativeWrapper.dll`, `main.js`, `bun.exe`, `launcher.exe` from GitHub releases.
   These may differ between downloads, may be corrupted by tar extraction bugs, and
   we can't verify they contain the fixes we need.

2. **Known bugs block us.** The Windows preload script fix (PR #224) is merged upstream
   but we can't reliably get the fixed DLL into our build. The tar extraction bug
   (`C:` interpreted as remote host) breaks the CLI download on Windows/MSYS.

3. **No visibility into failures.** When `startEventLoop` hangs, we have no way to
   diagnose it. The native code is a black box compiled somewhere else.

4. **The build pipeline is fragile.** Every `rm -rf node_modules` or cache clear
   triggers a re-download that may fail or produce different binaries.

## Fork Goals

1. **Build `libNativeWrapper.dll` from source on our CI** — reproducible, verifiable
2. **Fix the tar extraction bug** — use `--force-local` or Bun's native tar
3. **Include the preload fix** (PR #224) permanently
4. **Add startup watchdog** — if no window appears in 30s, exit cleanly instead of
   hanging as a zombie process
5. **Add structured logging** — `startEventLoop` should log every step of WebView2
   initialization with timestamps
6. **Benchmark app** — minimal test app to verify Windows startup time independent
   of KeepKey Vault's code

## Phase 1: Fork + Benchmark App

### 1.1 Fork the repo
```
gh repo fork blackboardsh/electrobun --org keepkey --clone
```

### 1.2 Cherry-pick fixes
- PR #224: Windows preload script views:// URL resolution
- Fix tar extraction: `--force-local` flag
- Add startup timeout/watchdog to `startEventLoop`

### 1.3 Build from source
Follow `BUILD.md`:
```
cd package
bun dev  # builds native wrappers + CLI + runs kitchen sink app
```

Verify `libNativeWrapper.dll` is built locally, not downloaded.

### 1.4 Create benchmark app
Minimal electrobun app that:
- Creates a BrowserWindow with a simple HTML page
- Logs timestamps for each initialization step
- Reports: time to window visible, time to content loaded, time to RPC ready
- Runs on Windows 10 and 11
- No external dependencies (no node_modules, no USB, no crypto)

**Target**: Window visible in < 3 seconds on cold start.

### 1.5 Publish as @keepkey/electrobun
```json
{
  "name": "@keepkey/electrobun",
  "version": "1.16.1-keepkey.1"
}
```

## Phase 2: Integrate with KeepKey Vault

1. Switch `keepkey-vault` dependency from `electrobun` to `@keepkey/electrobun`
2. Remove all workarounds (BOM strip, force-copy DLL, pre-placed wrapper, tar extraction hack)
3. `electrobun build` uses locally-built binaries from our fork
4. CI builds Windows installer with verified binaries

## Phase 3: Upstream Contributions

Contribute fixes back to `blackboardsh/electrobun`:
- Tar extraction fix
- Startup watchdog
- Structured Windows logging
- Any other fixes we discover

## Known Electrobun Issues to Fix in Fork

| Issue | Description | Severity |
|-------|-------------|----------|
| #210 | Preload script views:// URL not resolved on Windows | Critical — breaks window |
| N/A | tar extraction `C:` interpreted as remote host | Critical — breaks build |
| N/A | CLI downloads different binaries than npm package ships | High — inconsistent builds |
| N/A | startEventLoop hangs forever if WebView2 init fails | High — zombie processes |
| N/A | No structured logging in native code | Medium — can't diagnose failures |
| N/A | Zig 0.15.2 DrawTextW compat in wrapper-launcher.zig | Low — our wrapper code |
| N/A | version.json BOM from PowerShell 5 | Low — our build script |

## Files in This Repo Documenting the Journey

| Doc | Content |
|-----|---------|
| `docs/RETRO-WINDOWS-AUTO-UPDATE.md` | Auto-update revert decision |
| `docs/WINDOWS-ELECTROBUN-UPGRADE-INVESTIGATION.md` | Root cause: electrobun 1.13.1 preload bug |
| `docs/WINDOWS-STARTUP-OPTIMIZATION-PLAN.md` | Phased optimization plan |
| `docs/FIRMWARE-VS-BOOTLOADER-REBOOT-BUG.md` | OOB wizard reboot messaging bug |
| `docs/WINDOWS-QUIRKS.md` | 31 documented platform quirks |
| `docs/WINDOWS-DEV-MODE.md` | Dev mode troubleshooting |
| `docs/WINDOWS-OOB-REGRESSION.md` | OOB wizard race condition |
