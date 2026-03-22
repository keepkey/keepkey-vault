# Retro: Installer Failure — Full Session Log (2026-03-22)

## Duration: 15+ hours across v1.2.4, v1.2.5, v1.2.6

## Executive Summary

We cannot ship a working Windows installer. The ONLY working path is
hot-patching code into an existing v1.2.3 install. Every fresh install
from v1.2.4 through v1.2.6 fails to open a window.

## The One Thing That Works

```
1. Install v1.2.3 (works — window opens)
2. Replace Resources/app/bun/index.js with new code
3. Launch → window opens with new code running
```

This proves: **our application code is correct. The failure is in the
native binary layer that electrobun downloads at build time.**

## The Core Problem

`electrobun build` downloads `libNativeWrapper.dll` from GitHub releases
at build time. **Every build produces a different DLL hash:**

| Build | libNativeWrapper.dll Hash |
|-------|--------------------------|
| v1.2.3 (shipped, WORKS) | `66fe8878c95eef01...` |
| v1.2.5 build #1 | `fb671042a0e30d42...` |
| v1.2.5 build #2 | `f566485c2d41d2bc...` |
| v1.2.5 build #3 (signed) | `9b6ff9c291d0ff97...` |
| v1.2.5 build #4 | `f2c8fb7a3a6e3ff0...` |
| v1.2.5 + swap v1.2.3 DLL | `66fe8878c95eef01...` (still fails!) |
| v1.2.6 build | `103bf996f9be917b...` |

**Even swapping in the v1.2.3 DLL doesn't fix it** when installed via the
v1.2.5/v1.2.6 installer. But hot-patching into v1.2.3's install DOES work.

## What the Installer Does That Hot-Patching Doesn't

The installer runs `[InstallDelete]` which nukes:
- `{app}\Resources\app\views\mainview\assets` (stale Vite assets)
- `{localappdata}\sh.keepkey.vault` (Electrobun state)
- `{localappdata}\com.keepkey.vault` (WebView2 profiles + SQLite DB)

**Deleting `com.keepkey.vault` destroys the WebView2 user data folder.**
On this machine, WebView2 cannot reinitialize from scratch — `startEventLoop`
in `libNativeWrapper.dll` hangs forever during
`CreateCoreWebView2EnvironmentWithOptions` when creating a new profile.

Hot-patching works because it doesn't touch `com.keepkey.vault` — the warm
WebView2 profile from v1.2.3's successful launch is preserved.

## Evidence: app.log

The native layer writes to `bin/app.log`. When the app works:
```
setJSUtils called but using map-based approach instead of callbacks
Custom class failed, falling back to STATIC class
DEBUG loadViewsFile: .../index.html
DEBUG loadViewsFile: .../assets/index-{hash}.js
...
```

When the app fails (v1.2.4/5/6 fresh install):
- **app.log is EMPTY** — `startEventLoop` never reaches the logging phase
- OR app.log shows stale entries from a PREVIOUS run

## Evidence: vault-backend.log

When hot-patched (works):
```
[PERF] +1ms:    creating BrowserWindow
[PERF] +98ms:   window created, starting deferred init
[db] Stripped BOM from version.json
[db] SQLite cache ready at ...\vault.db
[PERF] +120ms:  db + chains loaded
[PERF] +2191ms: engine started
[PERF] +2192ms: boot complete
```

When fresh installed (fails):
- **vault-backend.log is EMPTY** — the bun Worker never starts executing
  because `startEventLoop` blocks the main thread before the Worker can
  initialize the native WebView2 environment

## Tests Performed

| # | Test | Result |
|---|------|--------|
| 1 | v1.2.3 installer → launch | WORKS (slow, 30-60s) |
| 2 | v1.2.3 + hot-patch v1.2.5 backend | WORKS |
| 3 | v1.2.4 installer → launch | FAILS |
| 4 | v1.2.5 installer → launch | FAILS |
| 5 | v1.2.5 + swap v1.2.3 DLL | FAILS |
| 6 | v1.2.5 + swap v1.2.3 DLL + main.js | FAILS |
| 7 | Upgrade electrobun 1.13.1 → 1.16.0 | FAILS (tar extraction bug) |
| 8 | Force-copy 1.16.0 DLL from npm pkg | FAILS |
| 9 | Kill all msedgewebview2 → launch | FAILS |
| 10 | Nuke WebView2 profile → launch | FAILS |
| 11 | v1.2.3 install → v1.2.5 over it | FAILS |
| 12 | v1.2.6 antidote installer | FAILS |
| 13 | v1.2.6 installer after manual kill of msedgewebview2 | Installs OK, launch FAILS |

## Root Cause (Final Assessment)

The v1.2.3 installer works because it was built and installed **before** the
WebView2 cold-start issue manifested on this machine. The WebView2 profile
was created during a successful first launch and has been warm ever since.

**Every subsequent installer (v1.2.4+) deletes the WebView2 profile via
`[InstallDelete]`.** This forces a cold WebView2 initialization which hangs
on this Win11 machine. The hang is in `CreateCoreWebView2EnvironmentWithOptions`
inside `libNativeWrapper.dll` — a native call we have no control over without
building electrobun from source.

## Blocking Issues for Future Agents

### 1. `electrobun build` produces non-deterministic binaries
Every run downloads different core binaries. We need to either:
- Build from source (fork at `modules/electrobun`)
- Pin exact binary hashes and verify after download
- Cache and reuse a known-good set of binaries

### 2. WebView2 cold-start hangs on some Windows machines
`CreateCoreWebView2EnvironmentWithOptions` never completes when creating
a fresh user data folder. This needs:
- Startup watchdog (30s timeout → exit cleanly)
- Pre-warm WebView2 at install time
- Logging inside `nativeWrapper.cpp` before the blocking call

### 3. No logging in the native layer during startup
`app.log` is only written AFTER successful initialization. The critical
failure path (WebView2 init hang) is completely dark. Need to add logging
to `nativeWrapper.cpp::startEventLoop` before any blocking call.

### 4. Installer destroys WebView2 profile
`[InstallDelete]` nukes `com.keepkey.vault` which contains the WebView2
user data. This should be changed to preserve the WebView2 profile:
```ini
; DON'T nuke the entire directory:
; Type: filesandordirs; Name: "{localappdata}\com.keepkey.vault"

; Instead, clean specific subdirectories:
Type: filesandordirs; Name: "{localappdata}\com.keepkey.vault\dev"
Type: filesandordirs; Name: "{localappdata}\sh.keepkey.vault"
```

### 5. The electrobun fork is set up but not built from source yet
Submodule at `modules/electrobun` (BitHighlander/electrobun) has the
preload fix but hasn't been compiled locally. Building from source
requires Visual Studio Build Tools + WebView2 SDK.

## Files to Reference

| File | Content |
|------|---------|
| `docs/ELECTROBUN-FORK-PLAN.md` | Fork decision document |
| `docs/ELECTROBUN-FORK-USAGE.md` | Build from source guide |
| `docs/WINDOWS-STARTUP-OPTIMIZATION-PLAN.md` | Startup optimization phases |
| `docs/WINDOWS-ELECTROBUN-UPGRADE-INVESTIGATION.md` | Preload bug root cause |
| `docs/evidence-2026-03-22-poisoned-state.md` | System state evidence |
| `docs/evidence-2026-03-22-session.md` | Full test results |
| `docs/logging-instrumentation-plan.md` | 6-phase logging plan |
| `docs/RETRO-WINDOWS-AUTO-UPDATE.md` | Auto-update revert |
| `scripts/installer.iss` | Current installer with antidote fixes |

## Immediate Next Steps

1. **Change `[InstallDelete]` to NOT delete `com.keepkey.vault`** — preserve
   WebView2 profile. Only clean `sh.keepkey.vault` and `dev/` profiles.
2. **Build electrobun from source** using the fork at `modules/electrobun`
3. **Add logging to `nativeWrapper.cpp::startEventLoop`** before the
   `CreateCoreWebView2EnvironmentWithOptions` call
4. **Add 30s watchdog** to exit if no window appears
5. **Test on a CLEAN Windows VM** to rule out machine-specific state
