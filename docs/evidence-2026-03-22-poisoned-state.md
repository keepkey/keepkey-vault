# Evidence: Poisoned Windows State — 2026-03-22

Machine: Windows 11 Home 10.0.26200 (bithi)

## 1. Orphaned msedgewebview2 Processes

**11 msedgewebview2.exe processes running with NO parent bun/launcher.**

```
msedgewebview2 16108  C:\Program Files (x86)\Microsoft\EdgeWebView\Application\146.0.3856.62\msedgewebview2.exe
msedgewebview2 17940  (same path)
msedgewebview2 19744
msedgewebview2 19820
msedgewebview2 20732
msedgewebview2 20764
msedgewebview2 20836
msedgewebview2 21088
msedgewebview2 30096
msedgewebview2 32252
msedgewebview2 32844
```

No bun.exe or launcher.exe running. These are orphaned WebView2 renderer
processes from failed app launches that never cleaned up. They hold locks
on the WebView2 user data folder.

**This is likely why fresh launches fail** — the WebView2 user data folder
at `com.keepkey.vault\stable\WebView2\` is locked by these orphaned processes.
New `CreateCoreWebView2EnvironmentWithOptions()` calls can't initialize
because the existing profile is locked.

## 2. Bloated WebView2 State

```
566M  /c/Users/bithi/AppData/Local/com.keepkey.vault/
  37M  stable/WebView2/         (production profile)
 528M  dev/                     (15 dev profiles! never cleaned up)
   0   release/                 (empty)
```

**15 dev-mode WebView2 profiles** accumulated over time, never cleaned:
```
webview2-20260226-192751
webview2-20260226-193737
webview2-20260226-194625
... (10 more)
```

Each dev profile is ~35MB. Total: 528MB of stale WebView2 data.

## 3. Duplicate Install Entries

Registry shows TWO KeepKey Vault entries:

```
KeepKey Vault       C:\Users\bithi\AppData\Local\KeepKey Vault\uninstall.exe
KeepKey Vault 1.2.5 C:\Users\bithi\AppData\Local\Programs\KeepKeyVault\unins000.exe
```

The first ("KeepKey Vault" with spaces, at `KeepKey Vault\`) is from an older
Electrobun self-extractor install. The second is our Inno Setup install.
Both claim to be installed. The old one's uninstaller may still be functional.

Also present: `Bun` as a standalone installed app.

## 4. Multiple KeepKey AppData Directories

```
/c/Users/bithi/AppData/Local/KeepKey Vault              ← old Electrobun self-extractor
/c/Users/bithi/AppData/Local/com.keepkey-desktop-v3.app  ← KeepKey Desktop v3
/c/Users/bithi/AppData/Local/com.keepkey-gui.app         ← old KeepKey GUI
/c/Users/bithi/AppData/Local/com.keepkey-vault.app       ← old Electrobun identifier?
/c/Users/bithi/AppData/Local/com.keepkey.vault           ← current (566MB)
/c/Users/bithi/AppData/Local/keepkey-desktop-updater     ← old desktop updater
```

6 different KeepKey-related AppData directories, most from old products.

## 5. SQLite Working After BOM Fix

```
vault.db     4096 bytes
vault.db-shm 32768 bytes
vault.db-wal 317272 bytes (active WAL = writes happening)
```

The BOM fix in our code (strip BOM from version.json before electrobun reads
it) is working — SQLite is now active. This is the first time settings have
persisted on this Windows machine.

## 6. Backend Log Shows Healthy Boot (When Hot-Patched)

```
[PERF] +1ms:    creating BrowserWindow
[PERF] +98ms:   window created, starting deferred init
[PERF] +120ms:  db + chains loaded
[PERF] +120ms:  REST API applied, starting engine
[PERF] +2191ms: engine started
[PERF] +2192ms: boot complete
```

Backend boots in 2.2 seconds. The window creation failure is NOT in our
TypeScript code — it's in the native layer (libNativeWrapper.dll + WebView2).

## Root Cause Theory (Updated)

The **orphaned msedgewebview2 processes** are the smoking gun. When the app
fails to create a window (WebView2 init fails or hangs), the WebView2
renderer processes are spawned but never cleaned up. They accumulate across
failed launches and hold locks on the user data folder. Each subsequent
launch attempt fails because the profile is locked.

**Kill chain:**
1. Install v1.2.5 → installer auto-launches app
2. WebView2 init fails (cold profile / DLL mismatch / timing issue)
3. bun.exe enters startEventLoop, blocks forever
4. msedgewebview2.exe processes spawned but orphaned
5. User force-kills bun.exe but msedgewebview2 processes survive
6. Next launch: WebView2 can't open locked profile → fails again
7. Repeat: more orphaned msedgewebview2 processes accumulate
8. Machine is "poisoned" until ALL msedgewebview2 processes are killed

**v1.2.3 worked** because it was installed on a clean machine (no orphaned
WebView2 processes) and its WebView2 init succeeded on first try.

## Recommended Immediate Actions

1. Kill all msedgewebview2 processes: `taskkill /f /im msedgewebview2.exe`
2. Delete stale WebView2 profiles: `rm -rf %LOCALAPPDATA%\com.keepkey.vault\dev\`
3. Delete old Electrobun install: `rm -rf "%LOCALAPPDATA%\KeepKey Vault"`
4. Uninstall "KeepKey Vault" (no version) from Add/Remove Programs
5. Try launching v1.2.5 again

## Recommended Code Actions

1. Installer: kill msedgewebview2 processes (not just bun/launcher)
2. Startup: if WebView2 init doesn't complete in 30s, kill self + child processes
3. Uninstaller: clean `com.keepkey.vault\` and `sh.keepkey.vault\` directories
4. Dev mode: clean up old webview2-* profiles on launch
