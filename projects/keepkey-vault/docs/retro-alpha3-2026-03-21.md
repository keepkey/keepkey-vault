# ALPHA-3 Test Retrospective — 2026-03-21

Branch: `release-cycle` @ commit `b93c3da`
Version: 1.2.6 (from version.json)
Machine: Windows 11 Home 10.0.26200
Installer: ALPHA-2 build (reused), EV-signed

---

## TEST A: Fresh install after full wipe

### Pre-conditions

- Both existing KeepKey Vault entries removed from Add/Remove Programs (user
  reported TWO entries — possible artifact of prior over-installs)
- All state directories deleted:
  - `%LOCALAPPDATA%\Programs\KeepKeyVault` — deleted, verified False
  - `%LOCALAPPDATA%\com.keepkey.vault` — deleted, verified False
  - `%LOCALAPPDATA%\sh.keepkey.vault` — deleted, verified False
  - `%LOCALAPPDATA%\KeepKey Vault` — deleted, verified False
- Machine confirmed clean before install

### Result: **FAIL**

```
TEST A (fresh install after full wipe):
1. MainWindowHandle: 0 (bun PID=32460), 0 (launcher PID=8828)
2. Did the window appear? NO
3. app.log has new entries? NO — app.log DOES NOT EXIST
4. backend.log exists? NO
```

### TEST A FAILED — fresh install on wiped machine fails.

Per plan rules: STOP. Do NOT continue to TEST B or C.

---

## Decision Tree Result

```
TEST A fails → native binary broken. Need Electrobun fork. STOP.
```

---

## Evidence

### Processes

| Process | PID | MainWindowHandle | Path |
|---------|-----|-----------------|------|
| bun | 32460 | 0 | `...\KeepKeyVault\bin\bun.exe` |
| launcher | 8828 | 0 | `...\KeepKeyVault\bin\launcher.exe` |

Both running from correct install path. Neither created a window.

### Logs

- **app.log**: DOES NOT EXIST (not even created)
- **backend.log**: DOES NOT EXIST

### Electrobun State

- `%LOCALAPPDATA%\com.keepkey.vault` — **DOES NOT EXIST**

WebView2 never created its user data folder. The
`CreateCoreWebView2EnvironmentWithOptions` call never completed, not even
enough to create the directory structure. This is a complete WebView2
initialization failure, not a profile corruption issue.

### Installed Files (All Correct)

**version.json:**
```json
{"version":"1.2.6","hash":"6929942fb4965507","channel":"stable",
 "baseUrl":"https://github.com/keepkey/keepkey-vault/releases/latest/download",
 "name":"keepkey-vault","identifier":"com.keepkey.vault"}
```

**index.html:**
```html
<script type="module" crossorigin src="./assets/index.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index.css">
```

**Assets** (clean — no stale hashed files from prior installs):
```
index.js           1,307,183
index.css                474
asset-data.js      3,216,096
StakingPanel.js       21,658
ZcashPrivacyTab.js    16,113
splash-bg.png      2,050,480
icon.png              39,895
cointracker.png        7,600
zenledger.png          5,910
+ 14 locale files
```

**bin:**
```
bun.exe            113,641,560
launcher.exe           328,704
libNativeWrapper.dll 1,565,144
libasar.dll            595,928
libasar-arm64.dll      529,368
WebView2Loader.dll     160,880
bspatch.exe            904,152
zig-zstd.exe         1,009,112
```

**DLL hash:** `AB432DE25EE9D02DA62D58DE932380B512298A0261A093262AB8D659D8DEB282`

Note: DLL hash differs from ALPHA-1 (`8588707A...`). ALPHA-1 was reading
the DLL from a prior install; this is the actual DLL from the ALPHA-2 build.

---

## What This Means

### Every prior hypothesis was wrong

| Hypothesis | Status |
|-----------|--------|
| ALPHA-1: WebView2 cache serves stale Vite hashes | WRONG — WebView2 never initialized |
| ALPHA-2: Stale WebView2 profile causes init hang | WRONG — fails on clean machine too |
| ALPHA-3: Profile wipe will fix it | WRONG — no profile exists, still fails |

### The binary itself is broken

The Electrobun native layer (`libNativeWrapper.dll` + `WebView2Loader.dll`)
cannot initialize WebView2 on this machine. This is not an installer
problem, not a profile problem, not a cache problem.

Evidence chain:
1. Clean machine (all state deleted, verified)
2. Fresh install (correct files on disk, verified)
3. Processes start and run (bun.exe + launcher.exe alive)
4. WebView2 user data folder never created (`com.keepkey.vault` absent)
5. No app.log created (Electrobun native logging never reaches `loadViewsFile`)
6. No window created (`MainWindowHandle = 0`)

The failure is in the Electrobun → WebView2 initialization path, before
any JavaScript executes, before any views load, before any logging occurs.

### Possible causes

1. **libNativeWrapper.dll is incompatible with this Windows 11 build**
   (10.0.26200). This is a recent Windows 11 Insider/Dev channel build.
   WebView2Loader.dll may be calling APIs that behave differently.

2. **WebView2 Runtime is missing or broken.** The installer runs
   `MicrosoftEdgeWebview2Setup.exe /silent /install` but this may have
   failed silently, or the runtime version is incompatible.

3. **Electrobun's WebView2 initialization code has a bug** that manifests
   on this specific Windows build. The `CreateCoreWebView2EnvironmentWithOptions`
   call hangs or fails silently.

4. **The launcher → bun handoff is broken.** `launcher.exe` spawns `bun.exe`
   but the IPC or WebView2 window creation path may be failing before the
   Electrobun native code runs.

### Recommended next steps

1. **Check WebView2 Runtime status:**
   ```powershell
   Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
   ```

2. **Try running bun.exe directly** from the install dir to see if it
   produces any stdout/stderr:
   ```powershell
   & "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\bun.exe" "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\app\bun\index.js" 2>&1
   ```

3. **Test on a different Windows machine** (Windows 10 or standard
   Windows 11, not Insider build) to isolate whether this is a machine-
   specific issue.

4. **Check if v1.2.1 (last known-good) still works on this machine.**
   If it doesn't, the machine's Windows build is the problem, not the
   Electrobun binary.

---

## Notable: TWO entries in Add/Remove Programs

User reported finding TWO KeepKey Vault entries in Add/Remove Programs
before wiping. This suggests the Inno Setup `AppId` changed at some
point, or the `PrivilegesRequired=lowest` setting caused a user-level
and system-level install to coexist. Worth investigating for the installer
but unrelated to the WebView2 failure.
