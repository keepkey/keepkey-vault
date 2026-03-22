# Windows Startup Optimization Plan

**Date**: 2026-03-21
**Goal**: Reduce Windows cold start from 60+ seconds to under 10 seconds
**Status**: Planning

## Current Baseline

| Metric | Value |
|--------|-------|
| Cold start (first launch) | 60+ seconds |
| Warm start (cached WebView2) | 15-30 seconds |
| Frontend JS bundle | 1.3 MB |
| Frontend asset-data chunk | 3.1 MB (static coin/token data) |
| Backend bundle (bun/index.js) | 2.1 MB |
| Shipped node_modules | 91 MB (286 packages) |
| Total app payload | 111 MB |
| Total build with binaries | 225 MB |

### Target

| Metric | Target |
|--------|--------|
| Cold start | < 10 seconds |
| Warm start | < 5 seconds |
| Shipped node_modules | < 20 MB |
| Total app payload | < 30 MB |

## Phase 1: Quick Wins (No Architecture Changes)

### 1.1 Lazy-load swagger/REST API docs
**Impact**: Remove 13 MB from startup path
**Risk**: Low
**Files**: `src/bun/index.ts`, `src/bun/rest-api.ts`

The `@swagger-api/*` packages (13 MB) are only used when the developer REST API
docs page is opened. Currently imported at startup.

**Change**: Dynamic `import()` when user opens API docs, not at module load.

### 1.2 Lazy-load asset-data chunk
**Impact**: Defer 3.1 MB JS parse from first paint
**Risk**: Low
**Files**: `src/mainview/` (vite config + asset-data imports)

The `asset-data-*.js` chunk contains static coin metadata, token lists, and chain
definitions. It's imported synchronously and blocks first render.

**Change**: Dynamic `import()` with a loading state. Show the UI shell immediately,
load asset data in background.

### 1.3 Defer engine initialization
**Impact**: Show UI 5-10 seconds faster
**Risk**: Low
**Files**: `src/bun/index.ts`, `src/bun/engine-controller.ts`

Currently at startup:
1. Initialize SQLite database
2. Scan for WebUSB device
3. Scan for HID device
4. Initialize wallet
5. Start REST API server
6. Check for updates
7. Initialize zcash sidecar

**Change**: Show the BrowserWindow first, THEN initialize engine. The UI can show
a "Connecting to device..." state while the engine starts.

### 1.4 Remove core-js-pure polyfill
**Impact**: Remove 6 MB from shipped node_modules
**Risk**: Low (Bun has modern JS support)
**Files**: `scripts/collect-externals.ts`

`core-js-pure` (6 MB) provides ES6+ polyfills. Bun runtime already supports all
modern JS features natively. Verify no dependency actually needs the polyfill at
runtime, then exclude it.

**Verification**:
```bash
grep -r "core-js-pure" _build/dev-win-x64/keepkey-vault-dev/Resources/app/node_modules/ \
  --include="*.js" -l | grep -v "core-js-pure/"
```

## Phase 2: Medium Effort

### 2.1 Pre-warm WebView2 at install time
**Impact**: Eliminate 5-15 second cold start penalty on first launch
**Risk**: Medium
**Files**: `scripts/installer.iss`, new `scripts/prewarm-webview2.js`

After Inno Setup installs the app, run a small script that:
1. Creates the WebView2 environment (`CreateCoreWebView2Environment`)
2. Loads a blank page
3. Exits

This creates the `EBWebView` user data folder so the first real launch is a warm start.

**Implementation**:
```iss
[Run]
Filename: "{app}\bin\bun.exe"; Parameters: "{app}\Resources\prewarm-webview2.js"; \
  Flags: runhidden waituntilterminated; StatusMsg: "Preparing application..."
```

### 2.2 Reduce shipped node_modules
**Impact**: Reduce 91 MB → ~20 MB
**Risk**: Medium (may break runtime imports)
**Files**: `scripts/collect-externals.ts`

Audit which packages are actually `require()`d at runtime vs build-time only:

| Package | Size | Needed at Runtime? |
|---------|------|--------------------|
| @swagger-api/* | 13 MB | Only for API docs (lazy-load) |
| core-js-pure | 6 MB | No (Bun has native support) |
| osmojs | 5 MB | Yes (Cosmos signing) |
| ramda-adjunct | 3.7 MB | Check — may be unused |
| ramda | 3.0 MB | Check — may be unused |
| lodash | 3.3 MB | Likely yes (used by swagger/minim) |
| web-streams-polyfill | 2.7 MB | No (Bun has native streams) |
| cosmjs-types | 2.4 MB | Yes (Cosmos types) |
| @babel/runtime | 1.8 MB | Check — may not be needed with Bun |

**Approach**: Add each to the `--external` list in the bun build command, test if
the app still starts. If it crashes with "Cannot find module", it's needed.

### 2.3 Bundle backend into single file (eliminate node_modules)
**Impact**: Eliminate 91 MB node_modules entirely, ship ~5 MB single bundle
**Risk**: Medium-High (native modules can't be bundled)
**Files**: `scripts/collect-externals.ts`, build pipeline

Currently we bundle `src/bun/index.ts` into a 2.1 MB file but ship 91 MB of
node_modules alongside it because some packages have native bindings or can't
be bundled.

**Truly unbundleable** (native .node bindings):
- `node-hid` (HID device access)
- `usb` (WebUSB)
- `secp256k1` (crypto)
- `tiny-secp256k1` (crypto)

Everything else (pure JS) should be bundleable. The bun build `--external` list
should only contain the native packages above.

**Test approach**:
1. Remove packages one by one from `--external` list
2. Rebuild backend: `bun build src/bun/index.ts --outdir /tmp/test --target bun --external node-hid --external usb --external secp256k1 --external tiny-secp256k1`
3. Test if the app starts and functions

## Phase 3: Electrobun Fork (Longer Term)

### Issues requiring a fork

| Issue | Description | Upstream Status |
|-------|-------------|-----------------|
| tar extraction bug | `tar -xzf "C:\..."` fails on Windows/MSYS | Not reported |
| CLI/npm DLL mismatch | `electrobun build` downloads different core binaries than npm package ships | Not reported |
| Preload script fix | views:// URLs not resolved on Windows | Fixed in v1.15.1 (PR #224) |
| Zig 0.15.2 compat | DrawTextW sentinel pointer cast | Not reported |
| version.json BOM | Build script writes UTF-8 BOM | Our code, not upstream |

### Fork plan

1. Fork `blackboardsh/electrobun` to `keepkey/electrobun`
2. Cherry-pick PR #224 (preload fix)
3. Fix tar extraction: use `--force-local` flag or extract with Bun's native tar
4. Pin core binary versions to match npm package version
5. Publish as `@keepkey/electrobun` on npm
6. Update `keepkey-vault` dependency

## Measurement Plan

Before and after each optimization, measure:

```bash
# Cold start (delete WebView2 profile first)
rm -rf "$LOCALAPPDATA/com.keepkey.vault/EBWebView"
time KeepKeyVault.exe  # measure until window title appears

# Warm start
time KeepKeyVault.exe  # measure until window title appears

# Backend startup
# Add timestamps to bun/index.ts:
# console.log(`[PERF] ${Date.now() - globalStartMs}ms: engine initialized`)
```

Track in a table:

| Change | Cold Start | Warm Start | Bundle Size |
|--------|-----------|------------|-------------|
| Baseline (v1.2.5) | 60s+ | 15-30s | 111 MB |
| After 1.1 (lazy swagger) | ? | ? | ? |
| After 1.2 (lazy assets) | ? | ? | ? |
| After 1.3 (defer engine) | ? | ? | ? |
| After 1.4 (remove core-js) | ? | ? | ? |
| After 2.1 (prewarm) | ? | ? | ? |
| After 2.2 (reduce modules) | ? | ? | ? |
| After 2.3 (single bundle) | ? | ? | ? |

## Priority Order

1. **1.3** Defer engine init — biggest perceived improvement, lowest risk
2. **1.1** Lazy-load swagger — biggest size reduction, easy
3. **1.4** Remove core-js-pure — 6 MB free, trivial
4. **1.2** Lazy-load asset-data — 3.1 MB deferred from first paint
5. **2.2** Reduce node_modules — audit and prune
6. **2.3** Single bundle — eliminates node_modules entirely
7. **2.1** Pre-warm WebView2 — smooths first launch
8. **3.x** Electrobun fork — fixes upstream bugs permanently
