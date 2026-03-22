# Electrobun Architecture & Build Pipeline

## Overview

Electrobun is a cross-platform desktop app framework that replaces Electron with **Bun runtime + Zig native binaries**. Instead of shipping Chromium, it uses the platform's native webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) or optionally bundles CEF.

KeepKey Vault uses Electrobun v1.13.1.

---

## High-Level App Architecture

```
┌─────────────────────────────────────────────────────────┐
│  User double-clicks "KeepKey Vault.exe"                 │
│  (wrapper-launcher.zig → bin/launcher.exe)              │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  launcher.exe (Zig binary)                              │
│  - Finds Resources/app/ relative to itself              │
│  - Runs: bun.exe Resources/app/bun/index.js             │
│  - Starts native GUI event loop via FFI                 │
└─────────────┬───────────────────────────────────────────┘
              │
    ┌─────────┴──────────┐
    ▼                    ▼
┌──────────────┐  ┌──────────────────────────────────────┐
│ Main Thread  │  │ Bun Worker Thread                    │
│ (GUI loop)   │  │ - Your code (index.ts → index.js)    │
│ - FFI bridge │  │ - RPC bridge to webview              │
│ - Native UI  │  │ - REST API server                    │
│              │  │ - USB device communication            │
└──────────────┘  └──────────────────────────────────────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │ BrowserWindow    │
                  │ (WebView2)       │
                  │ - React UI       │
                  │ - views://       │
                  │   mainview/      │
                  └──────────────────┘
```

**Key insight**: The main Bun thread creates a **Web Worker** to run your application code. The main thread itself is consumed by the native GUI event loop (via Bun FFI → libNativeWrapper.dll). Your code communicates with the native layer through FFI and with the webview through Electrobun's RPC bridge.

---

## The `// @bun` Header

When Electrobun builds your app, it calls `Bun.build()` with `target: "bun"`:

```typescript
// From electrobun-upstream/package/src/cli/index.ts:2465-2471
const buildResult = await Bun.build({
    ...bunBuildOptions,
    entrypoints: [bunSource],
    outdir: bunDestFolder,
    target: "bun",  // <-- THIS generates the // @bun header
});
```

The output file (`Resources/app/bun/index.js`) starts with:

```javascript
// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
// ... Bun runtime helpers ...
```

**What `// @bun` means:**
- It tells Bun this is a **pre-compiled bundle** targeting the Bun runtime
- Bun treats the file differently — it includes Bun-specific runtime helpers
- `require()` calls for **external** packages (those listed in `electrobun.config.ts` `build.bun.external`) are NOT inlined — they resolve at runtime from `node_modules/`

**What `target: "browser"` does differently:**
- Used for webview/view builds (the React UI)
- Does NOT generate the `// @bun` header
- Bundles everything for browser consumption

| Target | `// @bun` Header | Used For |
|--------|-----------------|----------|
| `target: "bun"` | YES | Backend code (Bun worker) |
| `target: "browser"` | NO | Frontend views (webview) |

---

## Directory Structure After Building

### Windows Build Output

```
build/dev-win-x64/keepkey-vault-dev/
├── KeepKey Vault.exe          ← Wrapper launcher (Zig, calls bin/launcher.exe)
├── bin/
│   ├── launcher.exe           ← Electrobun launcher (Zig, runs bun + GUI loop)
│   ├── bun.exe                ← Vendored Bun runtime
│   ├── libNativeWrapper.dll   ← Native GUI bindings (C++, WebView2)
│   └── WebView2Loader.dll     ← Microsoft WebView2 bootstrap
├── Resources/
│   ├── app/
│   │   ├── bun/
│   │   │   └── index.js       ← YOUR COMPILED CODE (// @bun header)
│   │   ├── views/
│   │   │   └── mainview/
│   │   │       ├── index.html  ← Vite-built React app
│   │   │       └── assets/     ← JS/CSS/images
│   │   └── node_modules/       ← External deps (from collect-externals.ts)
│   │       ├── @keepkey/
│   │       ├── ethers/
│   │       ├── node-hid/
│   │       ├── usb/
│   │       ├── google-protobuf/
│   │       └── ... (~180 packages)
│   ├── app.ico
│   ├── version.json
│   └── build.json
```

### macOS Build Output

```
KeepKey Vault.app/
├── Contents/
│   ├── MacOS/
│   │   ├── launcher            ← Electrobun launcher
│   │   ├── bun                 ← Vendored Bun runtime
│   │   └── libNativeWrapper.dylib
│   ├── Resources/
│   │   ├── app/
│   │   │   ├── bun/
│   │   │   │   └── index.js
│   │   │   ├── views/
│   │   │   │   └── mainview/
│   │   │   └── node_modules/
│   │   ├── version.json
│   │   └── AppIcon.icns
│   └── Info.plist
```

---

## Build Pipeline (Step by Step)

When you run `bun run build` in `projects/keepkey-vault/`, this happens:

### Step 1: Vite Build (Frontend)
```
vite build
  Input:  src/mainview/ (React app)
  Output: dist/index.html + dist/assets/
  Config: vite.config.ts (root: src/mainview, output: ../../dist)
```

### Step 2: Collect Externals (Dependencies)
```
bun scripts/collect-externals.ts
  Input:  node_modules/ + modules/hdwallet/ + modules/proto-tx-builder-vendored/
  Output: build/_ext_modules/ (~180 packages, pruned)
  See:    docs/collect-externals-deep-dive.md
```

### Step 3: Electrobun Build
```
electrobun build
  ├── Reads electrobun.config.ts
  ├── Bun.build() your src/bun/index.ts → Resources/app/bun/index.js
  │   - target: "bun" (generates // @bun header)
  │   - external: [@keepkey/*, google-protobuf, node-hid, usb, ethers]
  │   - These externals are NOT bundled, resolved at runtime
  ├── Copies dist/index.html → Resources/app/views/mainview/index.html
  ├── Copies dist/assets → Resources/app/views/mainview/assets
  ├── Copies build/_ext_modules → Resources/app/node_modules
  ├── Copies launcher.exe, bun.exe, libNativeWrapper.dll → bin/
  └── Generates version.json, build.json
```

### Build Variants

| Command | Environment | Signing | Output |
|---------|------------|---------|--------|
| `bun run build` | dev | None | `build/dev-win-x64/` |
| `bun run build:stable` | stable | macOS only | `build/stable-win-x64/` |
| `bun run build:canary` | canary | macOS only | `build/canary-win-x64/` |

---

## Path Resolution at Runtime

This is **critical** to understanding the relocatability problem.

### How the Launcher Finds Things

```typescript
// From electrobun-upstream/package/src/launcher/main.ts
const pathToLauncherBin = process.argv0;          // e.g. C:\Program Files\KeepKey Vault\bin\launcher.exe
const pathToBinDir = dirname(pathToLauncherBin);   // e.g. C:\Program Files\KeepKey Vault\bin\
const resourcesDir = join(pathToBinDir, "..", "Resources");  // e.g. C:\Program Files\KeepKey Vault\Resources\
const asarPath = join(resourcesDir, "app.asar");
```

This is **relative to the launcher binary**, which means the app IS relocatable — the launcher finds Resources/ by going up from its own location.

### How Native Wrapper is Loaded

```typescript
// From electrobun-upstream/package/src/bun/proc/native.ts:78
const nativeWrapperPath = join(process.cwd(), `libNativeWrapper.${suffix}`);
```

**Problem**: This uses `process.cwd()` NOT `process.argv0`. If the working directory doesn't match the install location, the DLL won't be found.

**The wrapper-launcher.zig fixes this** by setting `lpCurrentDirectory = exe_dir` when calling CreateProcessW, ensuring the CWD is always the app's root directory.

### How External Dependencies are Resolved

When `index.js` (with `// @bun` header) does `require("@keepkey/hdwallet-core")`, Bun resolves it by:

1. Looking in `./node_modules/` relative to the file
2. Walking up the directory tree looking for `node_modules/` folders
3. Using `NODE_PATH` environment variable

**In the build tree**: `Resources/app/bun/index.js` → walks up to `Resources/app/node_modules/` (where collect-externals put them)

**When relocated**: Same relative path works, AS LONG AS the entire directory structure is preserved.

---

## ASAR Packaging (Optional)

Electrobun supports packing the `app/` directory into an ASAR archive (like Electron):

```
Resources/
├── app.asar          ← Packed archive of app/
├── app.asar.unpacked/ ← Native modules (.node, .dll, .dylib, .so)
```

**Current KeepKey Vault config**: ASAR is NOT used (the `app/` directory is shipped as-is). This is simpler for debugging but means more files to sign and package.

Default unpack patterns: `["*.node", "*.dll", "*.dylib", "*.so"]` — native modules are always extracted because they can't be loaded from inside an archive.

---

## Electrobun Config Reference

```typescript
// projects/keepkey-vault/electrobun.config.ts
export default {
    app: {
        name: "keepkey-vault",
        identifier: "com.keepkey.vault",
        version: "1.0.0",
        urlSchemes: ["keepkey"],  // Handles keepkey:// protocol
    },
    build: {
        bun: {
            external: [
                // These are NOT bundled into index.js
                // They must exist in Resources/app/node_modules/ at runtime
                "@keepkey/hdwallet-core",
                "@keepkey/hdwallet-keepkey",
                "@keepkey/hdwallet-keepkey-nodehid",
                "@keepkey/hdwallet-keepkey-nodewebusb",
                "@keepkey/device-protocol",
                "google-protobuf",
                "node-hid",
                "usb",
                "ethers",
            ],
        },
        copy: {
            "dist/index.html": "views/mainview/index.html",
            "dist/assets": "views/mainview/assets",
            "build/_ext_modules": "node_modules",  // ← collect-externals output
        },
        win: {
            bundleCEF: false,  // Uses WebView2 (Edge) instead
            icon: "icon.png",
        },
    },
} satisfies ElectrobunConfig;
```

**Why externals exist**: Packages like `google-protobuf` use `this || window || global` patterns that break when Bun bundles them in ESM strict mode. Native modules like `node-hid` and `usb` contain `.node` binaries that can't be bundled. Marking them as external means Bun's bundler skips them, and they're loaded from `node_modules/` at runtime.

---

## The Polyfills Problem

```typescript
// projects/keepkey-vault/src/bun/polyfills.ts
// google-protobuf uses: this || window || global || self || Function("return this")()
// In Bun's strict ESM worker context: `this` is undefined, `window` doesn't exist
if (typeof globalThis.window === 'undefined') {
    ;(globalThis as any).window = globalThis
}
```

This must be imported BEFORE any `@keepkey/device-protocol` imports. The polyfill sets `globalThis.window = globalThis` so google-protobuf's global resolution works in Bun's worker context.

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `electrobun.config.ts` | Build configuration (externals, copy rules, signing) |
| `scripts/collect-externals.ts` | Collects runtime dependencies into build/_ext_modules |
| `scripts/build-signed.ts` | Wrapper for `electrobun build` with quiet-zip PATH fix |
| `src/bun/index.ts` | Main app entry (RPC bridge, device control, REST API) |
| `src/bun/polyfills.ts` | google-protobuf global scope fix |
| `src/bun/rest-api.ts` | REST API server (port 1646) |
| `src/mainview/` | React UI (Vite-built) |
| `vite.config.ts` | Vite config (React, port 5173, manual chunks) |
