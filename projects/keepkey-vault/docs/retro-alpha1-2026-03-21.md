# ALPHA-1 Test Retrospective — 2026-03-21

Branch: `release-cycle` @ commit `55a5d7a`
Version: 1.2.6 (from version.json)
Machine: Windows 11 Home 10.0.26200

---

## PLAN ALPHA-1 Step Results

| Step | Description | Result |
|------|------------|--------|
| 1 | Close KeepKey Vault | PASS |
| 2 | Checkout release-cycle | PASS (already on branch, pulled latest) |
| 3 | Verify installer is clean | PASS (matches were comments only, no directives) |
| 4 | Build frontend (`bunx vite build`) | PASS (4.71s, 1699 modules) |
| 5 | Collect externals | PASS (286 packages, 94MB final) |
| 6 | Electrobun build | PASS (icon embed warnings, non-fatal) |
| 7 | Windows production build | PASS (EV-signed, ISCC 25s) |
| 8 | Verify installer exists | PASS — `KeepKey-Vault-1.2.6-win-x64-setup.exe` (50.8 MB) |
| 9 | Install over existing v1.2.3 | Installer completed, app FAILED to launch |
| 10 | Wait 60 seconds | Done |
| 11 | Collect results | See below |
| 12 | Report | **FAIL** |

---

## Step 12 Report

1. **Did the installer finish?** YES
2. **Did a splash screen appear?** NO
3. **Did the main window appear?** NO
4. **MainWindowHandle:** `0` for both `bun` (PID 34828) and `launcher` (PID 24820)
5. **app.log:** Has content — all entries request STALE asset hash (see analysis below)
6. **backend.log:** NOT FOUND — backend never started
7. **DLL hash:** `8588707A276DC45BDFF45FB2102FEFAC6434FE63E8E7B2F61125E34A53FA0C69`

---

## Root Cause Analysis

### The Symptom

The app installs successfully but launches to a blank/invisible window. Both `bun.exe` and `launcher.exe` processes run but `MainWindowHandle` is `0` — no visible window.

### The Smoking Gun

**Installed `index.html`** references the correct, freshly-built JS bundle:
```html
<script type="module" crossorigin src="./assets/index-DljLeB3V.js"></script>
```

**But `app.log`** shows every launch attempt (4 sessions total in log) requesting a STALE hash from the previous install:
```
DEBUG loadViewsFile: Attempting flat file read: ...assets/index-B35QO2GT.js
```

The file `index-B35QO2GT.js` does NOT exist in the installed assets directory. Only `index-DljLeB3V.js` exists.

### The Root Cause: WebView2 Cache Poisoning

The WebView2 user data folder at `%LOCALAPPDATA%\com.keepkey.vault\stable\` persists across installs. When the installer overwrites the app files with a new build (new Vite content hashes), the WebView2 runtime continues serving the OLD `index.html` from its HTTP cache.

**Chain of failure:**
1. Installer writes new files (correct `index-DljLeB3V.js` on disk)
2. WebView2 launches and loads `index.html` from its **internal cache** (stale, references `index-B35QO2GT.js`)
3. Electrobun's `loadViewsFile` intercepts the request for `index-B35QO2GT.js`
4. File read fails silently (file doesn't exist)
5. No JS executes → no splash → no backend init → blank window
6. Process stays alive but does nothing

### Evidence

**Installed assets (correct):**
```
index-DljLeB3V.js       (new build)
index-CCtfaTm2.css
asset-data-B4q4DzbS.js
splash-bg-Bl_h0BVF.png
icon-Bka_ekkA.png
... (23 files total)
```

**app.log requests (stale):**
```
index-B35QO2GT.js        ← DOES NOT EXIST ON DISK
index-CCtfaTm2.css       ← exists (CSS hash unchanged)
asset-data-B4q4DzbS.js   ← exists (data hash unchanged)
splash-bg-Bl_h0BVF.png   ← exists
icon-Bka_ekkA.png        ← exists
```

Only the main JS bundle hash changed between builds. CSS, data, and images kept the same hash. The single changed file is the one that breaks everything.

**Electrobun state directories:**
- `%LOCALAPPDATA%\sh.keepkey.vault` — DOES NOT EXIST
- `%LOCALAPPDATA%\com.keepkey.vault\stable\` — EXISTS (WebView2 profile from prior install)

**backend.log** — NOT FOUND. Backend initialization never runs because it's triggered from JS, and the JS bundle never loads.

### Why This Wasn't Caught Before

The v1.2.1 installer that "worked" was always installed on clean machines or machines where the WebView2 cache happened to match. The over-install scenario (v1.2.3 → v1.2.6 with different Vite content hashes) was never tested.

---

## Filesystem State at Time of Failure

**Install directory** (`%LOCALAPPDATA%\Programs\KeepKeyVault`):
```
KeepKeyVault.exe          255,488 bytes
KeepKeyVault.exe.manifest     715 bytes
unins000.dat          133,559,793 bytes
unins000.exe            4,382,466 bytes
bin/
  app.log                   5,196 bytes
  bspatch.exe             904,152 bytes
  bun.exe             113,641,560 bytes
  launcher                424,960 bytes
  launcher.exe            328,704 bytes
  libasar-arm64.dll       529,368 bytes
  libasar.dll             595,928 bytes
  libNativeWrapper.dll  1,565,144 bytes
  WebView2Loader.dll      160,880 bytes
  zig-zstd.exe          1,009,112 bytes
Resources/
  version.json → {"version":"1.2.6", ...}
  app/views/mainview/index.html → refs index-DljLeB3V.js (correct)
  app/views/mainview/assets/ → 23 files (correct hashes)
```

**version.json:**
```json
{"version":"1.2.6","hash":"6929942fb4965507","channel":"stable","baseUrl":"https://github.com/keepkey/keepkey-vault/releases/latest/download","name":"keepkey-vault","identifier":"com.keepkey.vault"}
```

---

## Possible Fixes (For Discussion)

1. **Clear WebView2 cache on install** — Add `[InstallDelete]` for `{localappdata}\com.keepkey.vault\stable\Cache` (or the specific cache subfolder). Risk: this is the same pattern that caused the v1.2.5 poisoning. Needs evidence from the retro that it's safe to delete *just* the cache, not the entire profile.

2. **Disable WebView2 caching in Electrobun** — Configure `CreateCoreWebView2EnvironmentWithOptions` to disable caching or set cache-control headers on local file responses.

3. **Use a fixed asset filename** — Configure Vite to output `index.js` instead of `index-[hash].js`. Eliminates the cache mismatch entirely. Simplest fix but loses cache-busting for browser-based scenarios (not relevant for a desktop app).

4. **Add cache-busting query param** — Have `loadViewsFile` append `?v={version}` to local file URLs to force WebView2 to re-fetch.

5. **Delete only WebView2 HTTP cache on install** — More targeted than option 1. Identify the exact subfolder (`Cache/` or `Service Worker/CacheStorage/`) and delete only that.

---

## Build Artifacts

- Installer: `release-windows/KeepKey-Vault-1.2.6-win-x64-setup.exe` (50.8 MB, EV-signed)
- SHA256: `025072a9194a22d4a8508c3e9908fa940f43f037c22e70832d7acc82459bf18c`
- Signing cert: KEY HODLERS LLC EV (valid until 2028-07-02)
