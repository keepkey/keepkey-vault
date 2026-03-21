# Windows Dev Mode — Troubleshooting Guide

## Quick Start

```bash
cd projects/keepkey-vault

# Step 1: Build (only needed after code changes)
bunx vite build && bun scripts/collect-externals.ts && bunx electrobun build

# Step 2: Launch — MUST use launcher.exe directly, NOT electrobun dev
cd _build/dev-win-x64/keepkey-vault-dev/bin
./launcher.exe
```

**CRITICAL**: `bunx electrobun dev` does NOT work on Windows — it spawns
`launcher.exe` through an intermediate process that breaks WebView2 window
creation. Always launch `launcher.exe` directly from the `bin/` directory.

The `bun run dev:hmr:win` script handles all of this automatically.
If it fails, see below.

---

## What the Dev Script Does (in order)

1. Kills stale `bun`, `launcher`, `electrobun` processes from prior runs
2. Kills anything on port 5177 (HMR) and 50000 (app REST)
3. Deletes `_build/` (or renames if locked)
4. Sets unique WebView2 user-data folder (avoids profile locks)
5. Starts Vite HMR on port 5177 (background)
6. Runs `vite build` → `collect-externals` → `electrobun build`
7. Runs `electrobun dev` (foreground, console output visible)

---

## Known Failure Modes & Fixes

### 1. `_build/` is locked — EBUSY on rmdir

**Cause**: WebView2 runtime holds file handles on the build directory even after
the app process exits. Windows doesn't release them immediately.

**Fix**: The dev script tries `Remove-Item` then falls back to `Rename-Item`.
If both fail, Electrobun will try to overwrite (may work, may not).

**Nuclear option**: Reboot, or use Task Manager to kill any `msedgewebview2` processes.

### 2. No window opens — processes running but no UI

**Cause**: `electrobun dev` launches `launcher.exe` which creates a Bun Worker
and calls `startEventLoop`. The window is created by the **bun Worker process**,
not the launcher. If the Worker fails to start (missing module, crash), the
launcher stays alive but no window appears.

**Diagnosis**:
```powershell
# Check if bun has a window:
Get-Process bun | Select-Object Id, MainWindowTitle, MainWindowHandle
# MainWindowHandle = 0 means no window was created
```

**THE #1 CAUSE**: `bunx electrobun dev` was used instead of `launcher.exe`.
Electrobun's dev command spawns `launcher.exe` through an intermediate Node
process. On Windows, this breaks the process tree such that WebView2's
`CreateCoreWebView2EnvironmentWithOptions` never creates a window. The launcher
runs, the bun Worker starts, `startEventLoop` is called, but the HWND is never
created. All processes show `MainWindowHandle = 0`.

**The fix**: Always launch `_build/.../bin/launcher.exe` directly. The installed
production build works because `KeepKeyVault.exe` (Zig wrapper) calls
`CreateProcessW` directly — no intermediate process.

**Other causes**:
- Missing `@keepkey/device-protocol/lib/messages_pb` — submodule not built
- Syntax error in source files — check vite build output for errors
- `collect-externals` didn't run — `node_modules/` missing from `Resources/app/`

### 3. "failed to open" on launch

**Cause**: The native WebView2 initialization failed. Usually means:
- A syntax/runtime error in the frontend JS that crashes WebView2
- WebView2 Runtime not installed (Windows 10 only)
- Corrupt WebView2 user-data folder from a prior crash

**Fix**: Delete stale WebView2 profiles:
```powershell
Remove-Item -Recurse "$env:LOCALAPPDATA\com.keepkey.vault\dev\webview2-*"
```

### 4. HMR not connecting — "Vite dev server not running"

**Cause**: The HMR port is 5177 (not 5173). The old dev script used the wrong port.

**Verify**: `curl http://localhost:5177` should return Vite's HTML.

### 5. Double launch / duplicate log lines

**Cause**: Electrobun's dev mode spawns a child process that re-runs itself.
This is expected — the second set of logs is the actual app. Not a bug.

### 6. `rcedit ENOENT` warnings during build

**Cause**: Electrobun tries to embed icons using a hardcoded CI path
(`D:\a\electrobun\...`) that doesn't exist locally. Non-fatal — the production
build script handles icon embedding separately.

### 7. `zcash-cli not found` warning during build

**Cause**: The `zcash-cli` Rust binary isn't built in dev mode (no `cargo build`).
Non-fatal — Zcash features just won't work in dev. Build it manually if needed:
```bash
cd projects/keepkey-vault/zcash-cli && cargo build --release
```

### 8. Submodule build errors (hdwallet TS errors)

**Cause**: `modules/hdwallet` needs `yarn install && yarn build` which requires
the correct TypeScript version and may have type errors with newer TS.

**Fix**: The production build script handles this. For dev, if hdwallet is
already built from a prior production build, dev mode will use the cached output.

---

## Architecture: Why Dev Mode is Fragile on Windows

### The Launch Chain

```
bun run dev:hmr:win
  └─ PowerShell script
       ├─ Vite HMR server (port 5177, background)
       └─ vite build + collect-externals + electrobun build
            └─ electrobun dev
                 └─ launcher.exe (Electrobun native)
                      └─ bun.exe ../Resources/main.js
                           ├─ startEventLoop() → creates WebView2 window
                           └─ new Worker("app/bun/index.js") → app backend
```

### Why It's Harder Than macOS

| Issue | macOS | Windows |
|-------|-------|---------|
| Window creation | WKWebView (always works) | WebView2 (needs runtime, profile dir) |
| Process cleanup | Clean SIGTERM | Processes linger, hold file locks |
| File locking | POSIX (advisory) | Mandatory — can't delete open files |
| Build folder | `rm -rf` always works | EBUSY if WebView2 profile is inside |
| Icon embedding | `iconutil` (system tool) | `rcedit` (npm package, CI path bug) |
| Native wrapper | Not needed (`.app` bundle) | `wrapper-launcher.zig` (Zig compile) |

### The `_build/` Lock Problem

WebView2 creates a user-data folder inside the build tree (or references files
from it). When the app exits, Windows doesn't immediately release the file
handles. The next `electrobun build` tries to `rmdirSync(_build)` and gets EBUSY.

The fix in the dev script: unique WebView2 user-data folder per run at
`%LOCALAPPDATA%\com.keepkey.vault\dev\webview2-YYYYMMDD-HHmmss`. This keeps
the profile out of `_build/` so it can be deleted freely.

---

## Alternative: Hot-patch the Installed Build

If dev mode is broken and you need to test changes quickly, you can patch the
production-installed app:

```powershell
# Build just the frontend:
bunx vite build

# Copy to installed app:
$dest = "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\app\views\mainview"
Copy-Item dist/index.html "$dest/index.html"
Copy-Item dist/assets/* "$dest/assets/" -Recurse -Force

# Build just the backend:
bun build src/bun/index.ts --outdir $env:TEMP/bun-patch --target bun `
  --external node-hid --external usb --external @keepkey/hdwallet-core `
  --external @keepkey/hdwallet-keepkey --external @keepkey/hdwallet-keepkey-nodehid `
  --external @keepkey/hdwallet-keepkey-nodewebusb --external @keepkey/device-protocol `
  --external google-protobuf --external ethers --external @pioneer-platform/pioneer-client

# Copy to installed app:
Copy-Item "$env:TEMP/bun-patch/index.js" "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\app\bun\index.js"

# Relaunch:
& "$env:LOCALAPPDATA\Programs\KeepKeyVault\KeepKeyVault.exe"
```

This bypasses `electrobun build` entirely and patches the already-installed
binary. Useful when `_build/` is locked or you only changed TS/TSX files.

---

## Retro: What Went Wrong (2026-03-20 Session)

### Timeline — Round 1
1. Tried `bun run dev:hmr:win` — old script killed wrong port (5173 vs 5177)
2. Tried `bunx electrobun dev` directly — processes run but NO WINDOW
3. `_build/` got locked by WebView2, couldn't delete for rebuild
4. Tried running `bun.exe` directly from installed path — missing `device-protocol/lib/`
5. Resorted to hot-patching installed build (frontend + backend separately)
6. Rewrote `dev-hmr-windows.ps1` with proper cleanup
7. Script worked ONCE, then stopped working again

### Timeline — Round 2 (the real fix)
8. Rewrote script to use `bunx electrobun dev` — no window (MainWindowHandle=0)
9. Ran PowerShell script from Claude bash — output truncated, build killed by timeout
10. Ran 3 build steps manually (vite, collect-externals, electrobun build) — all passed
11. Ran `bunx electrobun dev` — launcher starts, Worker starts, NO WINDOW
12. Tested installed production build — WORKS (MainWindowHandle != 0)
13. Ran `launcher.exe` directly from dev build `bin/` dir — **WORKS**
14. Root cause: `bunx electrobun dev` spawns launcher through intermediate process
    that breaks WebView2 window creation on Windows

### Root Causes
- **`electrobun dev` breaks WebView2 on Windows**: The intermediate process
  between `bunx` and `launcher.exe` prevents `CreateCoreWebView2Environment`
  from creating an HWND. The installed build works because the Zig wrapper
  calls `CreateProcessW` directly with no intermediary.
- **Port mismatch**: `hmr` script uses 5177, old dev script killed 5173
- **No process cleanup**: Stale processes held file locks on `_build/`
- **No WebView2 isolation**: Profile inside `_build/` prevented deletion
- **Bash-to-PowerShell output loss**: Running PS1 from Claude's bash loses
  stdout and can timeout, killing long builds silently

### Timeline — Round 3 (launcher.exe also unreliable)
15. Rebased branch on latest develop, rebuilt all 3 steps — all passed
16. Ran `launcher.exe` directly from `bin/` — NO WINDOW (MainWindowHandle=0)
17. Same command that worked 30 minutes ago now fails
18. Installed production build via `KeepKeyVault.exe` — still works
19. Tried `Start-Process` with `-WorkingDirectory` — still no window
20. Tried copying installed `KeepKeyVault.exe` wrapper into dev build — window opens!
21. Multiple retries of `launcher.exe` direct — eventually works on ~5th attempt

**Root cause**: `launcher.exe` window creation is NON-DETERMINISTIC on Windows.
WebView2 `CreateCoreWebView2EnvironmentWithOptions` sometimes fails silently
depending on process environment, timing, and whether stale WebView2 profiles
exist. The Zig wrapper (`KeepKeyVault.exe`) is more reliable because:
- It uses `CREATE_NO_WINDOW` flag and Windows subsystem (no console)
- It sets CWD explicitly via `CreateProcessW`
- It doesn't inherit bash/PowerShell console environment

### The Reliable Dev Launch Method

**Build** (3 separate commands, each must succeed):
```bash
cd projects/keepkey-vault
bunx vite build
bun scripts/collect-externals.ts
bunx electrobun build
```

**Launch** (use the Zig wrapper from the installed production build):
```bash
cp /c/Users/bithi/AppData/Local/Programs/KeepKeyVault/KeepKeyVault.exe \
   projects/keepkey-vault/_build/dev-win-x64/keepkey-vault-dev/KeepKeyVault.exe
./projects/keepkey-vault/_build/dev-win-x64/keepkey-vault-dev/KeepKeyVault.exe
```

Or if `launcher.exe` direct isn't working, just hot-patch the installed build
(see "Alternative: Hot-patch the Installed Build" above).

### Root Causes (all rounds)
- **`electrobun dev` breaks WebView2**: Intermediate process prevents HWND creation
- **`launcher.exe` direct is non-deterministic**: WebView2 init depends on process
  environment, console inheritance, stale profiles, and timing. Sometimes works,
  sometimes doesn't. The Zig wrapper is the only reliable launch method.
- **Port mismatch**: `hmr` script uses 5177, old dev script killed 5173
- **No process cleanup**: Stale processes held file locks on `_build/`
- **WebView2 profile pollution**: Stale profiles under `%LOCALAPPDATA%` cause
  init failures. Clean with: `rm -rf %LOCALAPPDATA%/com.keepkey.vault/dev/webview2-*`
- **Bash-to-PowerShell output loss**: Running PS1 from Claude's bash loses
  stdout and can timeout, killing long builds silently
- **Chained commands swallow errors**: `cmd1 && cmd2 && cmd3` in bash — if
  the chain is backgrounded, failures are silent. Run each step separately.

### Lessons
1. **NEVER use `bunx electrobun dev` on Windows**
2. **`launcher.exe` direct is unreliable** — use the Zig wrapper or hot-patch
3. **The installed production build is the most reliable test target** — hot-patch it
4. Always kill KeepKey processes before rebuilding
5. Run build steps one at a time, check each exit code
6. Never chain build + launch in a single bash command
7. WebView2 on Windows is fragile — stale profiles, console inheritance, and
   process tree depth all affect whether a window appears
8. When in doubt: hot-patch the installed build, it always works
