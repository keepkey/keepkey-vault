# ALPHA-6 Launch Timing Analysis

## The Real Numbers

| Scenario | Launch to Window |
|----------|-----------------|
| First launch (post-install) | **56+ seconds** |
| Second launch (warm cache) | **1.1 seconds** |
| Demo app (minimal, no deps) | **~95ms** |

## Root Cause: Windows Defender Real-Time Scanning

First launch after install, Windows Defender scans every file that bun.exe
opens at runtime:

- `bun.exe` itself: 108.4 MB
- `index.js`: 2.1 MB
- 286 packages in `node_modules`: 67.4 MB total
- Native addons (`.node` files): node-hid, usb, secp256k1, keccak, etc.

Total: ~178 MB of files scanned on first run. At typical Defender scan
throughput (~3 MB/s for mixed small files), this takes 50-60 seconds.

### Evidence

- Process started at `23:29:58` (OS process creation time)
- First JS execution at `23:30:54` (backend.log first entry)
- **Gap: 56 seconds** before any application code runs
- All 16 import stages then complete in **3ms** — the imports themselves
  are instant, the delay is Defender scanning files as they're opened
- Second launch (Defender cache warm): **1.1 seconds** end-to-end

### Why the Demo App is Fast

The demo app has ~3 files and no node_modules. Defender scans it in
milliseconds. The Vault has 286 packages with thousands of files.

## Detailed Boot Timeline (Second Launch)

From backend.log `[PERF]` markers (all times relative to BrowserWindow creation):

```
+0ms      BrowserWindow creation starts
+109ms    Window created, deferred init starts
+110ms    deferredInit start
+120ms    DB + chains loaded
+121ms    REST API applied, engine starting
+313ms    Firmware manifest fetched (network)
+803ms    WebUSB device scan complete
+1565ms   Device paired
+2303ms   Device features read
+2305ms   Boot complete
```

### Phase Breakdown (warm cache)

| Phase | Duration | Notes |
|-------|----------|-------|
| Process start to JS | ~900ms | Bun startup + Defender (warm cache) |
| BrowserWindow creation | 109ms | Electrobun + WebView2 |
| DB + chains | 10ms | SQLite |
| Network (manifest) | 192ms | Can be deferred |
| USB scan | 490ms | Hardware I/O |
| Device pair + init | 1500ms | Hardware I/O |
| **Total (warm)** | **~3.2s** | |

## Optimization Options

### 1. Reduce Defender Scan Surface (HIGH IMPACT on first launch)

**Bundle node_modules into a single file.** Instead of 286 packages
with thousands of individual files, use `bun build` to create a single
bundled `backend.js`. Defender scans 1 file instead of thousands.

Estimated improvement: First launch from 56s to ~5-8s.

Risk: Native addons (`node-hid`, `usb`, `secp256k1`, `keccak`) cannot
be bundled. They'll still be scanned individually. But eliminating the
~4000 pure-JS files is the big win.

### 2. Add Defender Exclusion in Installer (MEDIUM IMPACT)

The installer could add `%LOCALAPPDATA%\Programs\KeepKeyVault` to
Defender's exclusion list. Requires admin rights (the installer
already asks for elevation).

Risk: Security optics — users may not want to exclude an app directory
from antivirus. Also some enterprise policies prevent exclusions.

### 3. Defer USB/Device Init (MEDIUM IMPACT on perceived speed)

Show the UI immediately, scan for device in background. The splash
screen appears at +109ms but the app isn't interactive until the
engine starts at +2305ms.

If we show a "Connecting to device..." state in the UI, the window
appears fast and the user sees progress.

### 4. Reduce node_modules Size (MEDIUM IMPACT)

Current: 67.4 MB across 286 packages. Top offenders:

| Package | Size | Needed at Runtime? |
|---------|------|--------------------|
| @swagger-api | 9.9 MB | Only if REST API enabled |
| swagger-client | 2.9 MB | Only if REST API enabled |
| osmojs | 3.5 MB | Only for Osmosis txs |
| web-streams-polyfill | 2.6 MB | Bun has native streams |
| ramda-adjunct | 2.3 MB | Utility lib |
| cosmjs-types | 2.1 MB | Only for Cosmos txs |

Lazy-loading swagger-client + @swagger-api alone would save 12.8 MB
and ~3500 files from the initial scan.

### 5. Cache Firmware Manifest (LOW IMPACT)

Save manifest to disk, use cached version if <1hr old. Saves ~192ms
on warm launches. Not impactful enough to prioritize.

## Recommendation

**Priority 1**: Bundle JS into single file (`bun build --target=bun`).
This is the only fix that dramatically improves first-launch time.
Everything else is incremental.

**Priority 2**: Defer device init until after window paint. Makes
warm launches feel instant.

**Priority 3**: Lazy-load swagger/REST API deps. Saves 13MB from scan.
