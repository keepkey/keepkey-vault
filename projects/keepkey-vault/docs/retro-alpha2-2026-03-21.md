# ALPHA-2 Test Retrospective — 2026-03-21

Branch: `release-cycle` @ commit `ae14540`
Version: 1.2.6 (from version.json)
Machine: Windows 11 Home 10.0.26200
Previous state: ALPHA-1 install (v1.2.6 with hashed filenames) over v1.2.3

---

## What Changed Since ALPHA-1

Vite content hashes removed. Output is now `assets/index.js` instead of
`assets/index-[hash].js`. Goal: fix WebView2 cache serving stale filenames.

---

## PLAN ALPHA-2 Step Results

| Step | Description | Result |
|------|------------|--------|
| 1 | Close KeepKey Vault | PASS |
| 2 | Pull latest | PASS (ae14540) |
| 3 | Verify vite fix present | PASS — `entryFileNames: "assets/[name].js"` in vite.config.ts |
| 4 | Build frontend | PASS (4.67s, 1699 modules) |
| 5 | Verify no content hashes | PASS — `index.js`, `asset-data.js`, etc. No hashes. |
| 6 | Collect externals | PASS (286 packages, 94MB) |
| 7 | Electrobun build | PASS (icon embed warnings, non-fatal) |
| 8 | Windows production build | PASS (EV-signed) |
| 9 | Verify installer exists | PASS — 50.8 MB |
| 10 | Install over existing | Installer completed, app FAILED to launch |
| 11 | Wait 60 seconds | Done |
| 12 | Collect results | See below |
| 13 | Report | **FAIL** |

---

## Step 13 Report

1. **Did the installer finish?** YES
2. **Did a splash screen appear?** NO
3. **Did the main window appear?** NO
4. **MainWindowHandle:** `0` for both `bun` (PID 42180) and `launcher` (PID 35036)
5. **app.log:** Has content but ALL entries are STALE from prior sessions (latest: Sat Mar 21 21:19:43). **No new entries from ALPHA-2 launch.**
6. **Does app.log reference `index.js` or `index-[hash].js`?** Neither — no new entries were written. Stale entries reference `index-B35QO2GT.js` (from pre-ALPHA-1 installs).
7. **backend.log:** NOT FOUND
8. **JS filenames in assets directory:**
   - `index.js` (new, 1,307,183 bytes) — CORRECT
   - `index-DljLeB3V.js` (stale from ALPHA-1, 1,308,884 bytes)
   - `asset-data.js` + `asset-data-B4q4DzbS.js` (both present)
   - All locale files present in both hashed and unhashed versions

---

## Root Cause Analysis

### ALPHA-1 Analysis Was Wrong

ALPHA-1 concluded the failure was WebView2 cache serving stale `index.html` with
old Vite content hashes. **This was incorrect.** The real failure occurs earlier
in the startup sequence.

### The Real Root Cause: WebView2 Initialization Hang

The app never reaches the `loadViewsFile` stage at all. Evidence:

- **app.log has ZERO new entries from ALPHA-2.** The last entry is from
  `21:19:43` (an earlier session). ALPHA-2 installed and launched AFTER that
  timestamp. If the Electrobun webview had initialized, it would have written
  `setJSUtils called` and `loadViewsFile` entries. It did not.

- **Both bun.exe and launcher.exe are running** (PIDs 42180, 35036) from the
  correct install path. The processes started but are stuck.

- **MainWindowHandle = 0** for both processes. No window was ever created.

### Chain of Failure

```
1. Installer completes successfully
2. launcher.exe starts → spawns bun.exe
3. bun.exe starts → calls Electrobun init
4. Electrobun calls CreateCoreWebView2EnvironmentWithOptions
   with userDataFolder = %LOCALAPPDATA%\com.keepkey.vault\stable
5. WebView2 runtime HANGS during initialization
   (corrupted/stale profile from prior installs)
6. No window is created → MainWindowHandle stays 0
7. No view loads → no loadViewsFile calls → no app.log entries
8. No JS executes → no backend init → no backend.log
9. Process stays alive indefinitely, doing nothing
```

### Why the Vite Fix Didn't Help

The Vite content hash removal was the correct fix for the symptom identified
in ALPHA-1, but the symptom was misdiagnosed. The stale `index-B35QO2GT.js`
entries in app.log were from **previous sessions**, not from the ALPHA-1 launch.
The ALPHA-1 launch also produced no new log entries — we just didn't notice
because we assumed the latest log entries were from the current session.

The files on disk are now correct:
- `index.html` → `src="./assets/index.js"` ✓
- `assets/index.js` exists (1.3 MB) ✓

But it doesn't matter because WebView2 never gets far enough to load them.

---

## Evidence

### Installed Assets (Correct)

Both old (hashed) and new (unhashed) versions present due to over-install
not cleaning old files:

```
index.js                    1,307,183 bytes  (ALPHA-2, correct)
index-DljLeB3V.js           1,308,884 bytes  (ALPHA-1, stale)
index.css                         474 bytes
index-CCtfaTm2.css                474 bytes
asset-data.js               3,216,096 bytes
asset-data-B4q4DzbS.js      3,216,096 bytes
... (all locale/chunk files duplicated in hashed + unhashed)
```

### index.html (Correct)

```html
<script type="module" crossorigin src="./assets/index.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index.css">
```

### version.json

```json
{"version":"1.2.6","hash":"6929942fb4965507","channel":"stable",
 "baseUrl":"https://github.com/keepkey/keepkey-vault/releases/latest/download",
 "name":"keepkey-vault","identifier":"com.keepkey.vault"}
```

### WebView2 Profile State

```
%LOCALAPPDATA%\com.keepkey.vault\
  └── stable\
      └── WebView2\
          └── Partitions\
```

This profile has persisted across multiple installs (v1.2.3 → ALPHA-1 → ALPHA-2).
It is the likely cause of the WebView2 initialization hang.

### Processes

| Process | PID | Path | MainWindowHandle |
|---------|-----|------|-----------------|
| bun | 42180 | `...\KeepKeyVault\bin\bun.exe` | 0 |
| launcher | 35036 | `...\KeepKeyVault\bin\launcher.exe` | 0 |

### Logs

- **app.log**: 5,196 bytes, last entry `Sat Mar 21 21:19:43 2026` (pre-ALPHA-2)
- **backend.log**: NOT FOUND

---

## Corrected Understanding

| What We Thought (ALPHA-1) | What's Actually Happening |
|---------------------------|--------------------------|
| WebView2 cache serves stale index.html | WebView2 never initializes |
| loadViewsFile fails on wrong filename | loadViewsFile is never called |
| Fix: remove Vite content hashes | Fix: address WebView2 profile corruption |

---

## Recommendations

### Option A: Delete WebView2 profile on install (targeted)

Add to installer.iss `[InstallDelete]`:
```ini
[InstallDelete]
Type: filesandirs; Name: "{localappdata}\com.keepkey.vault\stable\WebView2"
```

**Risk**: This is exactly the pattern that caused the v1.2.5 poisoning
(deleting `com.keepkey.vault` caused WebView2 cold-start hang). However,
deleting just the `WebView2` subfolder (not the entire `com.keepkey.vault`)
may be safe. Needs testing.

### Option B: Delete entire com.keepkey.vault on install

```ini
[InstallDelete]
Type: filesandirs; Name: "{localappdata}\com.keepkey.vault"
```

**Risk**: Higher. Forces full WebView2 re-initialization. This is what
v1.2.5 did and it caused hangs. Only viable if the hang was caused by
something else in the v1.2.5 installer (the `[Code]` section process kills,
`CloseApplications`, etc.)

### Option C: Use a fresh WebView2 profile per version

Change the Electrobun `userDataFolder` to include the version number:
`com.keepkey.vault-1.2.6` instead of `com.keepkey.vault`. Each install gets
a clean profile. Old profiles accumulate but don't interfere.

### Option D: Test on a CLEAN machine

The current machine has been poisoned by multiple over-installs. Before
adding more installer complexity, test the ALPHA-2 build on a clean
Windows VM with no prior KeepKey Vault installation. If it works clean,
the problem is specifically the stale WebView2 profile, confirming
Option A/B/C.

### Option E: Manual unpoison then re-test

1. Uninstall via Add/Remove Programs
2. Delete `%LOCALAPPDATA%\com.keepkey.vault`
3. Delete `%LOCALAPPDATA%\sh.keepkey.vault`
4. Reinstall ALPHA-2

If this works, it proves the WebView2 profile is the sole blocker,
and we can proceed with Option A.

---

## Secondary Issue: Stale Files Accumulate

The over-install leaves old hashed files alongside new unhashed files in
`Resources/app/views/mainview/assets/`. This wastes ~10MB+ of disk space
and could cause confusion. The installer's `[Files]` section uses
`ignoreversion` but doesn't clean old files.

**Fix**: Add `[InstallDelete]` for the assets directory:
```ini
[InstallDelete]
Type: filesandirs; Name: "{app}\Resources\app\views\mainview\assets"
```

This is safe — the installer will recreate the directory with fresh files.

---

## Build Artifacts

- Installer: `release-windows/KeepKey-Vault-1.2.6-win-x64-setup.exe` (50.8 MB, EV-signed)
- SHA256: checked via build script
- Vite fix confirmed: all JS assets use stable filenames
