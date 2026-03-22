# Snapshot: v1.2.3 Running Successfully — 2026-03-22 21:20 CDT

This is the KNOWN GOOD baseline state. v1.2.3 is running with window visible.
Any installer upgrade must preserve this state or reproduce it.

## Processes

```
bun            21088  MainWindowTitle: "KeepKey Vault v1.2.3"  Path: ...\KeepKeyVault\bin\bun.exe
launcher        3172  (no title)                               Path: ...\KeepKeyVault\bin\launcher.exe
msedgewebview2  14184 (12 instances)                           Path: ...\EdgeWebView\Application\146.0.3856.72\...
```

- bun.exe has MainWindowTitle — window IS visible
- 12 msedgewebview2 processes — these are the WebView2 renderers for our app
- launcher.exe running as parent

## Installed Version

```json
{"version":"1.2.3","hash":"6b2794113458442a","channel":"stable","baseUrl":"https://github.com/keepkey/keepkey-vault/releases/latest/download","name":"keepkey-vault","identifier":"com.keepkey.vault"}
```

**NOTE: version.json has BOM (EF BB BF)** — this is the PowerShell 5 bug.
Despite the BOM, the app launches because the native layer reads version.json
separately from the bun Worker (which crashes on BOM but continues).

## Binary Hashes (KNOWN GOOD)

```
libNativeWrapper.dll: 66fe8878c95eef01a414a777b9d75b0289c3f3945ed2310918ae9a5ccea96f1b
main.js:              dc7c0cd922fce45f39e8f9e0eb40eb25f1df0b806cc9890b208292c3398ae9e9
```

These are the electrobun 1.13.1 binaries that WORK. Any replacement must be
verified against these hashes.

## WebView2 Profile (CRITICAL — MUST PRESERVE)

```
com.keepkey.vault/
  stable/          11MB (warm WebView2 profile)
```

- Only `stable/` exists — dev profiles were cleaned by v1.2.6 installer
- 11MB is a fresh warm profile (was 37MB+ before cleanup)
- This directory MUST survive installer upgrades

## app.log (Native Layer — WORKING)

```
[21:19:43] setJSUtils called but using map-based approach instead of callbacks
[21:19:43] Custom class failed, falling back to STATIC class
[21:19:43] loadViewsFile: .../index.html
[21:19:43] loadViewsFile: .../assets/index-B35QO2GT.js
[21:19:43] loadViewsFile: .../assets/index-CCtfaTm2.css
[21:19:43] loadViewsFile: .../assets/asset-data-B4q4DzbS.js
[21:19:44] loadViewsFile: .../assets/splash-bg-Bl_h0BVF.png
[21:19:44] loadViewsFile: .../assets/icon-Bka_ekkA.png
```

All 6 files loaded successfully. Window appeared ~1s after loadViewsFile calls.

## Registry

```
KeepKey Vault 1.2.3  → ...\KeepKeyVault\unins000.exe
Bun                  → standalone bun install (separate)
KeepKey Desktop 3.2.0 → old desktop app (separate)
```

Clean — only one KeepKey Vault entry. The old "KeepKey Vault" (no version)
entry from the Electrobun self-extractor was cleaned by previous installer runs.

## AppData Directories

```
com.keepkey.vault           ← CURRENT (11MB, warm profile)
com.keepkey-desktop-v3.app  ← old desktop v3
com.keepkey-gui.app         ← old GUI
com.keepkey-vault.app       ← old identifier
com.vault-v2.app            ← vault v2 (Tauri)
keepkey-desktop-updater     ← old updater
vault-v2                    ← vault v2 data
```

No `sh.keepkey.vault` — cleaned by installer.
No `KeepKey Vault` (with space) — cleaned by installer.
No `dev/` profiles — cleaned by installer.

## Scheduled Tasks

None — `ElectrobunUpdate_*` tasks cleaned by installer.

## What Must Be True After v1.2.6 Upgrade

1. `com.keepkey.vault/stable/` directory still exists (WebView2 profile)
2. No new processes that weren't there before
3. app.log shows loadViewsFile calls with NEW asset hashes (not B35QO2GT)
4. vault-backend.log shows PERF timestamps and SQLite ready
5. Window opens with title "KeepKey Vault v1.2.6"
