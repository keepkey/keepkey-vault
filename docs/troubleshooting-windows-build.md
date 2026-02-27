# Troubleshooting: Windows Build Issues

## Issue #1: App Works in Build Tree, Fails When Installed (Relocatability)

### Symptoms
- `bun run dev` works perfectly — window opens, app functions
- After installing via Inno Setup (or copying to another directory), the app:
  - Shows a blank window, or
  - Doesn't open a window at all, or
  - Opens briefly then crashes silently

### Root Cause

The Bun Worker that loads `Resources/app/bun/index.js` fails silently because external `require()` calls can't find their packages.

**Why it works in the build tree**: Bun walks up the directory tree and finds `projects/keepkey-vault/node_modules/` (the dev install).

**Why it fails when relocated**: That parent `node_modules/` doesn't exist at the install location. The app's own `Resources/app/node_modules/` doesn't contain all needed packages.

### Diagnosis

```bash
# 1. Check if the build output has node_modules:
ls build/dev-win-x64/keepkey-vault-dev/Resources/app/node_modules/

# 2. Check what's missing — compare against what index.js needs:
#    Open build/dev-win-x64/keepkey-vault-dev/Resources/app/bun/index.js
#    Search for require(" to find all external requires

# 3. Test relocatability explicitly:
mkdir /tmp/vault-test
cp -r build/dev-win-x64/keepkey-vault-dev/* /tmp/vault-test/
cd /tmp/vault-test
./bin/launcher.exe
# Watch for errors — if it fails, a dependency is missing
```

### Fix

Add missing packages to the `EXTERNALS` array in `scripts/collect-externals.ts`.

**Why the dependency walker misses packages:**
The `@keepkey/*` packages use `file:` links to the hdwallet monorepo. Bun resolves these as symlinks, but `collect-externals.ts` can't follow the transitive dependency chain through them. Any runtime dependency of `hdwallet-core` or `hdwallet-keepkey` that isn't found via the main `node_modules/` tree must be listed explicitly in `EXTERNALS`.

**Also check STRIP_DIRS:** Packages listed in `STRIP_DIRS` are completely deleted from the bundle. Never strip a package without verifying it's truly unused **at the installed location** (not the build tree). In v1.0.1, `rxjs` and `lodash` were wrongly stripped — both are still `require()`d by `hdwallet-core/dist/`.

**Packages confirmed required at runtime (as of v1.0.1):**
- `rxjs` — `hdwallet-core/dist/utils.js` lines 27-28
- `lodash` — `hdwallet-core/dist/wallet.js` (lodash/isObject)
- `protobufjs`, `libsodium-wrappers` — crypto/protobuf support
- `@cosmjs/amino`, `@cosmjs/crypto`, `@cosmjs/encoding`, `@cosmjs/json-rpc`, `@cosmjs/math`, `@cosmjs/proto-signing`, `@cosmjs/socket`, `@cosmjs/stream`, `@cosmjs/tendermint-rpc`, `@cosmjs/utils` — Cosmos tx building
- `@confio/ics23`, `cosmjs-types`, `isomorphic-ws`, `xstream`, `readonly-date`, `lru-cache`

### Diagnosis (quick method)

```powershell
# Run the app bundle directly from the INSTALLED location:
Set-Location 'C:\Users\...\AppData\Local\Programs\KeepKeyVault'
& '.\bin\bun.exe' run './Resources/app/bun/index.js'
# Bun will print the first missing package immediately, e.g.:
# error: Cannot find package 'rxjs' from '...\hdwallet-core\dist\utils.js'
```

Fix each missing package, rebuild, reinstall, repeat until `Server started at http://localhost:50000` appears.

### Full missing-package scanner

Write a script that scans all `require()` calls in the bundle + node_modules and checks which packages don't exist in the installed `node_modules/`. Filter out Node.js builtins (`fs`, `path`, `http`, etc.) and Babel helper names. This finds all missing packages in one pass instead of fixing them one-by-one.

After fixing, rebuild:
```bash
cd projects/keepkey-vault
bun scripts/collect-externals.ts  # Just re-collect
bun run build                     # Full rebuild
```

---

## Issue #2: Electrobun Dev CLI Crash (Issue #133)

### Symptoms
```
error: SyntaxError: Unexpected token 'else'
```
The `electrobun dev` command crashes because `else` gets stripped during Zig compilation of the CLI binary.

### Root Cause

Electrobun issue #133 — a bug in how the Zig compiler strips whitespace from the CLI source. The `else` keyword in a conditional gets removed, producing invalid JavaScript.

### Status

**Fixed in Electrobun main branch.** The fix hasn't been released to npm yet (as of v1.13.1).

### Workaround

Update to latest Electrobun from git:
```bash
# In keepkey-vault-public/:
cd projects/keepkey-vault
# Update electrobun to latest git main:
bun add electrobun@github:aspect-build/electrobun#main
```

Or apply the patch via `scripts/patch-electrobun.sh` (the `postinstall` hook).

---

## Issue #3: ENOBUFS During `electrobun build`

### Symptoms
```
Error: ENOBUFS
```
or build hangs/crashes when Electrobun tries to zip the app bundle.

### Root Cause

Electrobun's CLI uses `Bun.spawnSync()` with a 1MB `maxBuffer` to run `zip -y -r -9 ...`. With ~180 packages in node_modules (13,000+ files), the per-file zip output exceeds 1MB and causes ENOBUFS.

### Fix

Already fixed in this project. `scripts/build-signed.ts` puts a quiet-zip shim on PATH:

```typescript
// scripts/build-signed.ts
const result = Bun.spawnSync(
    ['electrobun', 'build', `--env=${env}`],
    {
        env: {
            ...process.env,
            // Our scripts/zip shim adds -q (quiet) flag
            PATH: `${scriptsDir}${process.platform === 'win32' ? ';' : ':'}${currentPath}`,
        },
    }
)
```

Use `bun run build:stable` or `bun run build:canary` instead of calling `electrobun build` directly.

---

## Issue #4: google-protobuf `this || window` Error

### Symptoms
```
ReferenceError: window is not defined
```
or
```
TypeError: Cannot read properties of undefined
```
when `@keepkey/device-protocol` tries to import `google-protobuf`.

### Root Cause

`google-protobuf` uses this pattern:
```javascript
var global = this || window || global || self || Function("return this")()
```

In Bun's strict ESM worker context:
- `this` is `undefined`
- `window` doesn't exist
- The expression fails

### Fix

Already fixed in `src/bun/polyfills.ts`:

```typescript
// Must be imported BEFORE any @keepkey/device-protocol or hdwallet imports
if (typeof globalThis.window === 'undefined') {
    ;(globalThis as any).window = globalThis
}
```

This is imported as the first line of `src/bun/index.ts`. If you add new entry points or workers, make sure polyfills is imported first.

---

## Issue #5: Worker Silently Dies (No Error Output)

### Symptoms
- App launches but shows blank window
- No error messages in terminal
- No crash dialog

### Root Cause

When the Bun Worker that runs `index.js` encounters a fatal error (missing module, syntax error, etc.), it dies without propagating the error to the main thread. The GUI event loop continues running, showing the webview (which loads fine from static files), but no backend code executes.

### Diagnosis

```bash
# 1. Run launcher directly (not via wrapper) to see stdout/stderr:
cd build/dev-win-x64/keepkey-vault-dev
./bin/launcher.exe 2>&1

# 2. Use electrobun dev (shows all output in terminal):
cd projects/keepkey-vault
bunx electrobun dev

# 3. Add debug logging to the top of src/bun/index.ts:
console.log("[VAULT] Worker starting...")
import './polyfills'
console.log("[VAULT] Polyfills loaded")
// ... imports ...
console.log("[VAULT] All imports loaded")
```

### Common Causes

1. **Missing node_modules package** → see Issue #1
2. **Native module load failure** (node-hid, usb) → wrong platform prebuilds
3. **google-protobuf global scope** → see Issue #4
4. **CWD mismatch** → libNativeWrapper.dll not found (see Issue #6)

---

## Issue #6: CWD Mismatch / DLL Not Found

### Symptoms
- App crashes immediately on startup
- Error about `libNativeWrapper.dll` not found

### Root Cause

Electrobun's native.ts loads the native wrapper relative to CWD:
```typescript
// electrobun-upstream/package/src/bun/proc/native.ts:78
const nativeWrapperPath = join(process.cwd(), `libNativeWrapper.${suffix}`)
```

If the app is launched with a different working directory (e.g., from a shortcut, Start menu, or script), the DLL path is wrong.

### Fix

The wrapper launcher (`scripts/wrapper-launcher.zig`) fixes this by explicitly setting the CWD to the app's root directory:

```zig
// The wrapper sets lpCurrentDirectory when calling CreateProcessW
const ok = CreateProcessW(
    null,
    cmd_w,        // "bin\launcher.exe"
    null, null,
    0, 0, null,
    cwd_w,        // ← CWD set to wrapper's own directory
    &si, &pi,
);
```

**If you see this issue**, make sure:
1. The Inno Setup shortcut points to `"KeepKey Vault.exe"` (the wrapper), NOT `bin\launcher.exe`
2. The shortcut's "Start in" directory is the app's install directory

---

## Issue #7: Icon Shows as Generic/Wrong

### Symptoms
- App icon in taskbar/Start menu is generic Windows icon
- Icon looks pixelated or wrong resolution

### Root Cause

Electrobun outputs `app.ico` which is actually a PNG file with the wrong extension. Windows expects a proper ICO file (multi-resolution container format).

### Fix

The production build script (`build-windows-production.ps1`) converts PNG to proper ICO:

```powershell
# Creates multi-resolution ICO: 16x16, 32x32, 48x48, 256x256
# Output: Resources/app-real.ico
```

This is used by Inno Setup as the installer icon and by the wrapper EXE.

For dev builds, you can convert manually:
```powershell
# Using ImageMagick:
magick icon.png -define icon:auto-resize=16,32,48,256 icon.ico
```

---

## Issue #8: WebView2 Profile Lock

### Symptoms
- App fails to start with error about WebView2 user data directory being locked
- Happens when running multiple instances or after crash

### Root Cause

WebView2 locks its user data directory. If a previous instance didn't shut down cleanly, the lock persists.

### Fix

The dev HMR script creates unique user data folders per run:
```powershell
# scripts/dev-hmr-windows.ps1
$webview2Dir = "$env:LOCALAPPDATA\com.keepkey.vault\dev\webview2-$(Get-Date -Format 'yyyyMMddHHmmss')"
```

For production: Kill any hanging `bun.exe` or `launcher.exe` processes:
```powershell
taskkill /F /IM bun.exe
taskkill /F /IM launcher.exe
```

The user data directory is at:
```
%LOCALAPPDATA%\com.keepkey.vault\
```

---

## Issue #9: Native Module Prebuilds Missing

### Symptoms
```
Error: Could not find native module for platform win32-x64
```
or
```
Error: The module 'node_modules/node-hid/prebuilds/win32-x64/node.napi.node' was not found
```

### Root Cause

`collect-externals.ts` removes prebuilds for non-current platforms. If it ran on the wrong platform or had a bug, the Windows prebuilds might be missing.

### Diagnosis

```bash
# Check node-hid prebuilds:
ls build/_ext_modules/node-hid/prebuilds/
# Should have: win32-x64/

# Check usb prebuilds:
ls build/_ext_modules/usb/prebuilds/
# Should have: win32-x64/

# Check tiny-secp256k1:
ls build/_ext_modules/tiny-secp256k1/prebuilds/
# Should have: win32-x64/
```

### Fix

Run collect-externals on Windows to get the right prebuilds:
```bash
cd projects/keepkey-vault
bun scripts/collect-externals.ts
```

Check the platform detection logic in `collect-externals.ts:230-234`:
```typescript
const REMOVE_PREBUILD_PREFIXES = isWindows
    ? ['linux', 'darwin', 'android']  // Correct: remove non-Windows
    : // ...
```

---

## Quick Reference: Build Commands

| Command | What It Does | When to Use |
|---------|-------------|-------------|
| `bun run dev` | Full dev build + launch | Day-to-day development |
| `bun run dev:hmr:win` | Dev with hot reload | UI development on Windows |
| `bun run build` | Build only (no launch) | Testing build output |
| `bun run build:stable` | Build with signing (macOS) | macOS release |
| `.\scripts\build-windows-production.ps1` | Full Windows release | Windows release |
| `.\scripts\build-windows-production.ps1 -SkipSign` | Build without signing | Testing installer |
| `.\scripts\build-windows-production.ps1 -SkipBuild` | Re-sign/re-package only | Fix signing issues |

---

## Quick Reference: Key Paths

| Path | Contents |
|------|----------|
| `projects/keepkey-vault/build/_ext_modules/` | Collected external packages |
| `projects/keepkey-vault/build/dev-win-x64/keepkey-vault-dev/` | Complete build output |
| `projects/keepkey-vault/build/.../Resources/app/bun/index.js` | Compiled app code |
| `projects/keepkey-vault/build/.../Resources/app/node_modules/` | Runtime dependencies |
| `projects/keepkey-vault/build/.../bin/` | Executables (launcher, bun, DLLs) |
| `release-windows/` | Final installer artifacts |
| `scripts/` | Build scripts (PS1, Zig, ISS) |
| `modules/hdwallet/` | Git submodule: hardware wallet SDK |
| `modules/proto-tx-builder-vendored/` | Vendored Cosmos tx builder |

---

## Quick Reference: What to Update When Adding Dependencies

If you add a new npm package that must be available at runtime (not bundled):

1. **Add to `electrobun.config.ts` `build.bun.external`** — tells Bun.build() not to bundle it
2. **Add to `collect-externals.ts` `EXTERNALS`** — tells the collector to ship it
3. **Verify it's NOT in `STRIP_DIRS`** — or only subdirectories are stripped, not the whole package
4. **Run `bun run build` and test relocatability** — install via Inno Setup and run from the installed location

If the package has native modules (`.node` files), also check that platform prebuilds are preserved by the pruning logic.

---

## Golden Rule

> **Never trust "it works in dev."** Always test from the installed location.
> Bun's directory-walking module resolution masks missing dependencies
> when a parent `node_modules/` exists in the build tree.
