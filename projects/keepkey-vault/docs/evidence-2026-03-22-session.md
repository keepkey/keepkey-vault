# Evidence: Full Session Log — 2026-03-22

## Machine
- Windows 11 Home 10.0.26200 (bithi)
- WebView2 Runtime: 146.0.3856.62 (via Edge, not standalone)

## Definitive Test Results

### Binary Comparison (v1.2.3 vs v1.2.5)

All core binaries are IDENTICAL:

| File | v1.2.3 Hash | v1.2.5 Installed Hash | Match? |
|------|-------------|----------------------|--------|
| libNativeWrapper.dll | `66fe8878c95eef01...` | `66fe8878c95eef01...` | YES |
| main.js | `dc7c0cd922fce45f...` | `dc7c0cd922fce45f...` | YES |
| bun.exe | `39f12024edc27d37...` | `39f12024edc27d37...` | YES |

### What Works vs What Doesn't

| Test | Result |
|------|--------|
| v1.2.3 installer → launch | Opens (slow, 30-60s) |
| v1.2.3 install → hot-patch v1.2.5 bun/index.js → launch | Opens |
| v1.2.5 installer → launch | NEVER opens |
| v1.2.5 install → swap in v1.2.3 DLL + main.js → launch | NEVER opens |
| v1.2.3 install → v1.2.5 install over it → launch | NEVER opens |
| Kill all msedgewebview2 → launch v1.2.5 | NEVER opens |

### Conclusion

**The binaries are identical. The code is identical (hot-patch works).
Something the v1.2.5 INSTALLER does — beyond just placing files — breaks
the system.** The installer itself poisons the state.

## app.log Evidence (Native Layer)

The native `libNativeWrapper.dll` writes to `bin/app.log`. Key observations:

### When v1.2.3 works:
```
setJSUtils called but using map-based approach instead of callbacks
Custom class failed, falling back to STATIC class
DEBUG loadViewsFile: .../index.html
DEBUG loadViewsFile: .../assets/index-B35QO2GT.js
DEBUG loadViewsFile: .../assets/index-CCtfaTm2.css
DEBUG loadViewsFile: .../assets/asset-data-B4q4DzbS.js
DEBUG loadViewsFile: .../assets/splash-bg-Bl_h0BVF.png
DEBUG loadViewsFile: .../assets/icon-Bka_ekkA.png
```
Window appears after loading these files.

### When v1.2.5 fails:
app.log is **EMPTY** — the native lib never gets past `startEventLoop`.
No `setJSUtils`, no `loadViewsFile`, nothing.

OR: app.log shows stale entries from a PREVIOUS v1.2.3 run, indicating
the current v1.2.5 process never wrote to it.

### Critical: Stale Asset References

app.log shows the native lib loading `index-B35QO2GT.js` — this is from
a PREVIOUS build. The current v1.2.5 build produces `index-DljLeB3V.js`.
This means the native lib is reading from cache, not from the actual files.

## backend log (vault-backend.log)

From the hot-patched run (the only successful v1.2.5 code execution):

```
[PERF] +1ms:    creating BrowserWindow
[PERF] +98ms:   window created, starting deferred init
[PERF] +98ms:   deferredInit start
[db] Stripped BOM from version.json
[db] SQLite cache ready at ...\vault.db
[PERF] +120ms:  db + chains loaded
[PERF] +120ms:  REST API applied, starting engine
[PERF] +2191ms: engine started
[PERF] +2192ms: boot complete
```

Backend boots in 2.2s. Window creation, DB, engine all work.
The failure is in the native layer — startEventLoop never initializes.

## System State (Poisoned)

### Orphaned WebView2 Processes
11 msedgewebview2.exe processes running with no parent app.
Killing them did NOT fix the problem — they may be Edge browser processes.

### Bloated AppData
```
566MB  com.keepkey.vault/
  37MB  stable/WebView2/        (production profile)
 528MB  dev/                    (15 dev profiles, never cleaned)
```

### Duplicate Install Registry
```
KeepKey Vault       → C:\Users\bithi\AppData\Local\KeepKey Vault\uninstall.exe
KeepKey Vault 1.2.5 → C:\Users\bithi\AppData\Local\Programs\KeepKeyVault\unins000.exe
Bun                 → standalone bun install
```

### 6 KeepKey AppData Directories
```
KeepKey Vault/              ← old Electrobun self-extractor
com.keepkey-desktop-v3.app  ← KeepKey Desktop v3
com.keepkey-gui.app         ← old KeepKey GUI
com.keepkey-vault.app       ← old identifier
com.keepkey.vault           ← current (566MB)
keepkey-desktop-updater     ← old updater
```

## Open Questions

1. **What does the v1.2.5 installer do differently?** The files are identical
   but the installer itself poisons the system. Possible causes:
   - `[InstallDelete]` in installer.iss cleans the assets dir, destroying
     the WebView2 profile's cached asset references
   - `[Code]` section kills processes, disrupting WebView2 state
   - The installer touches the WebView2 user data folder somehow
   - The installer's process cleanup kills something that shouldn't be killed

2. **Why does the native lib not write to app.log?** On failed launches,
   `startEventLoop` enters but never initializes logging. This suggests
   it hangs on the Win32 message window creation or WebView2 environment
   creation — before any logging code runs.

3. **Why does hot-patching work?** Because hot-patching only replaces
   `Resources/app/bun/index.js` and doesn't run the installer. The installer's
   side effects (process kills, directory cleans, registry changes) are what
   cause the poisoning.
