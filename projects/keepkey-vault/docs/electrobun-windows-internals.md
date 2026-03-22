# Electrobun Windows Internals

Deep technical reference for how Electrobun packages, installs, updates, and
runs on Windows. Written to support the v1.2.5 poison-installer investigation
and inform the Electrobun fork decision.

Source: `electrobun@1.13.1` (npm package, NOT a submodule).

---

## Package Identity

- npm: `electrobun@1.13.1`
- Consumed via: `projects/keepkey-vault/package.json`
- Patched at install time: `scripts/patch-electrobun.sh` (zip ENOBUFS fix)
- CLI source: `node_modules/electrobun/src/cli/index.ts` (4092 lines)
- Updater source: `node_modules/electrobun/dist-macos-arm64/api/bun/core/Updater.ts` (~1100 lines)
- No `dist-win-x64/` directory ships in the npm package on macOS hosts

---

## Build Pipeline (Windows)

The Windows build does NOT use Electrobun's built-in packaging for the final
installer. Instead, we have a two-stage pipeline:

### Stage 1: Electrobun Build

```
vite build
  -> dist/ (frontend assets)

bun scripts/collect-externals.ts
  -> _build/_ext_modules/ (native modules + node_modules subset)

electrobun build (--env=stable|canary|dev)
  -> _build/dev-win-x64/keepkey-vault-dev/
       bin/
         launcher.exe    (Electrobun native binary)
         bun.exe         (Bun runtime)
       Resources/
         app/
           bun/index.js  (backend bundle)
           views/mainview/  (Vite output)
           node_modules/    (collected externals)
           version.json
         app.ico          (WRONG: renamed PNG, not real ICO)
```

### Stage 2: Windows Production Build

`scripts/build-windows-production.ps1` takes the Electrobun output and:

1. Converts PNG to proper multi-size ICO (`System.Drawing`)
2. Compiles `scripts/wrapper-launcher.zig` -> `KeepKeyVault.exe`
3. Creates DPI-aware manifest (`KeepKeyVault.exe.manifest`)
4. Signs all EXEs with EV certificate (`signtool`)
5. Downloads WebView2 bootstrapper from Microsoft CDN
6. Compiles `scripts/installer.iss` with Inno Setup 6 (ISCC)
7. Signs the final setup EXE

### Final Artifact

```
release-windows/KeepKey-Vault-{VERSION}-win-x64-setup.exe
```

This is a standard Inno Setup installer, NOT Electrobun's self-extractor.

---

## Installed Directory Layout

After Inno Setup runs, the installed app lives at:

```
{autopf}\KeepKeyVault\              (typically C:\Users\{user}\AppData\Local\Programs\KeepKeyVault\)
  KeepKeyVault.exe                  Zig wrapper launcher
  KeepKeyVault.exe.manifest         DPI awareness manifest
  bin\
    launcher.exe                    Electrobun native launcher
    bun.exe                         Bun runtime (~113MB)
  Resources\
    app\
      bun\index.js                  Backend entry point
      views\mainview\               Frontend (Vite output)
        index.html
        assets\                     Hashed JS/CSS chunks (accumulate across versions!)
      node_modules\                 Collected external dependencies
      version.json                  App version + hash metadata
    app-real.ico                    Proper Windows ICO
```

**No spaces in path** -- Bun Workers silently fail with spaces.

---

## Runtime State Locations (Outside Install Dir)

These directories are NOT managed by the Inno Setup installer and survive
uninstall:

### 1. Electrobun App State

```
%LOCALAPPDATA%\sh.keepkey.vault\
  stable\                           (or canary\, dev\)
    self-extraction\
      {hash}.tar                    Extracted update archives
      {hash}.patch                  Binary patches
      latest.tar.zst               Downloaded update archive
      update.bat                    Update script (scheduled task)
    app\                            Running app copy (Electrobun-managed)
```

### 2. WebView2 User Data

```
%LOCALAPPDATA%\com.keepkey.vault\
  dev\
    webview2-{timestamp}\           Dev-mode profiles (unique per run)
  stable\
    webview2\                       Production profile
      EBWebView\                    Chromium user data
        Default\
          Cache\
          IndexedDB\
          Local Storage\
```

### 3. Windows Scheduled Tasks

```
ElectrobunUpdate_{timestamp}        Created during update application
                                    Should self-delete but often doesn't
```

### 4. Bun Cache

```
%LOCALAPPDATA%\.bun\                Bun's global cache (if bun was installed separately)
```

---

## The Electrobun Update Mechanism (Windows)

Source: `Updater.ts` lines 947-1025

### Normal Flow

1. App checks for updates (GitHub API or Electrobun's `{channel}-update.json`)
2. Downloads new version as `.tar.zst` to `self-extraction/`
3. Extracts to `self-extraction/{hash}/` directory
4. Creates `update.bat` in the PARENT of the running app directory
5. Registers `update.bat` as a Windows Scheduled Task (`ElectrobunUpdate_{timestamp}`)
6. Runs the scheduled task immediately
7. Calls `quit()` to close the app

### update.bat Contents

```bat
@echo off
setlocal

:: Wait for launcher.exe to exit
:waitloop
tasklist /FI "IMAGENAME eq launcher.exe" 2>NUL | find /I /N "launcher.exe">NUL
if "%ERRORLEVEL%"=="0" (
    timeout /t 1 /nobreak >nul
    goto waitloop
)

:: Extra delay for file handle release
timeout /t 2 /nobreak >nul

:: Remove current app folder
if exist "C:\...\app" (
    rmdir /s /q "C:\...\app"
)

:: Move new app to current location
move "C:\...\self-extraction\{hash}" "C:\...\app"

:: Clean up extraction directory
rmdir /s /q "C:\...\self-extraction" 2>nul

:: Launch the new app
start "" "C:\...\app\bin\launcher.exe"

:: Clean up scheduled tasks
for /f "tokens=1" %%t in ('schtasks /query /fo list ^| findstr /i "ElectrobunUpdate_"') do (
    schtasks /delete /tn "%%t" /f >nul 2>&1
)

:: Delete this script
ping -n 2 127.0.0.1 >nul
del "%~f0"
```

### Failure Modes

| Step | Failure | Consequence |
|------|---------|-------------|
| `rmdir /s /q` old app | DLL locked by WebView2 process | Old app partially deleted, mixed state |
| `move` new app | Old dir not fully removed | Move fails, NO app directory exists |
| `schtasks /delete` | Task name parsing fails | Orphaned scheduled tasks accumulate |
| `del "%~f0"` | Script still running | Stale update.bat left behind |
| `start launcher.exe` | App dir corrupted from above | New version fails to launch |

### Critical Gap: No Rollback

If `rmdir` succeeds but `move` fails, the user has NO app directory. There is
no backup, no rollback, no recovery path. The machine is in a state where:

- The old app is deleted
- The new app failed to move into place
- The installer thinks a version is installed (registry/AppId)
- Reinstall may fail because stale state remains

This is the most likely "poison" scenario.

---

## Electrobun Self-Extractor vs Inno Setup

Electrobun ships its own self-extracting mechanism (Zig-compiled binary that
unpacks `.tar.zst` archives). We do NOT use this for distribution. Instead:

| Aspect | Electrobun Native | Our Pipeline |
|--------|-------------------|--------------|
| Installer format | ZIP with extractor.exe + tar.zst | Inno Setup EXE |
| Install location | `%LOCALAPPDATA%\{identifier}\{channel}\` | `{autopf}\KeepKeyVault\` |
| Uninstall | None (no Add/Remove Programs entry) | Inno Setup uninstaller |
| Update | update.bat + scheduled task | GitHub releases redirect (PR #41) |
| WebView2 | User must have it | Bootstrapper bundled in installer |
| Code signing | Not built in | EV cert via build script |

**However**, even though we use Inno Setup for distribution, Electrobun's
update mechanism is still compiled into the app. If it activates (checking
for updates via the built-in channel), it will create `update.bat` and
scheduled tasks regardless of how the app was originally installed.

This is the conflict: **two update systems coexist**, and Electrobun's can
corrupt the Inno-Setup-managed install directory.

---

## The Version.json BOM Bug (PR #43)

PowerShell 5's `-Encoding UTF8` writes a BOM (`EF BB BF`) at the start of
`version.json`. Electrobun's `getVersionInfo()` fails to parse the file,
causing `Utils.paths.userData` to throw. This is caught silently, meaning:

- Settings never persist on Windows
- Tutorial completion state resets every launch
- Cached balances never persist
- API logs never persist
- `Utils.paths.userData` returns undefined -> SQLite DB path is wrong

This has been broken on Windows since v1.0 and is fixed in PR #43.

---

## Wrapper Launcher Architecture

`scripts/wrapper-launcher.zig` compiles to `KeepKeyVault.exe`:

- Uses `CreateProcessW` to launch `bin\launcher.exe`
- Sets `CREATE_NO_WINDOW` (0x08000000) to prevent console flash
- Sets CWD to the EXE's own directory
- Closes process/thread handles after spawn (fire-and-forget)
- Has a splash screen with `LoadImageW` + Win32 window

This wrapper is MORE RELIABLE than launching `launcher.exe` directly because:
- No console environment inheritance
- Clean process tree (no intermediate shell)
- WebView2's `CreateCoreWebView2EnvironmentWithOptions` creates HWNDs reliably

`electrobun dev` and direct `launcher.exe` launches are non-deterministic on
Windows due to process tree depth and console inheritance.

---

## Native Module Signing

`build-windows-production.ps1` signs EXEs with the EV certificate:

- `KeepKeyVault.exe` (wrapper)
- `launcher.exe` (Electrobun native)
- Final setup EXE

NOT signed (can't be):
- `.node` native addon binaries (signtool doesn't support them)
- `bun.exe` (113MB, rcedit corrupts it)

SmartScreen may warn on unsigned `.node` files.

---

## File Reference

| File | Purpose |
|------|---------|
| `scripts/installer.iss` | Inno Setup installer definition |
| `scripts/build-windows-production.ps1` | Full Windows build + signing pipeline |
| `scripts/wrapper-launcher.zig` | Zig wrapper EXE source |
| `scripts/patch-electrobun.sh` | Postinstall Electrobun patch (zip ENOBUFS) |
| `scripts/collect-externals.ts` | Node_modules collection for bundle |
| `scripts/prune-app-bundle.ts` | Post-build bundle pruning |
| `projects/keepkey-vault/electrobun.config.ts` | Electrobun app configuration |
| `docs/WINDOWS-QUIRKS.md` | 33 documented platform quirks |
| `docs/WINDOWS-DEV-MODE.md` | Dev mode troubleshooting |
