# collect-externals.ts Deep Dive

## What It Does

`collect-externals.ts` solves a fundamental problem: Bun's bundler can't bundle native modules (`.node` files) or packages that rely on dynamic `this`/`window`/`global` patterns. These packages must be marked as `external` in `electrobun.config.ts` and shipped as real `node_modules/` in the app bundle.

This script collects those packages AND all their transitive dependencies into `build/_ext_modules/`, then prunes them aggressively for size.

---

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│  1. Start with 37 explicitly listed EXTERNALS                │
│     @keepkey/*, node-hid, usb, ethers, bignumber.js, etc.    │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  2. Recursively resolve ALL transitive dependencies          │
│     Read each package.json → add its deps → recurse          │
│     Result: ~180+ packages                                   │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  3. Copy all packages to build/_ext_modules/                 │
│     - File-linked packages (hdwallet) from modules/ dirs     │
│     - Regular packages from node_modules/                    │
│     - Fallback to hdwallet/node_modules/ for transitive deps │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  4. Prune unnecessary files                                  │
│     - README, LICENSE, CHANGELOG, test dirs                  │
│     - .d.ts, .map, .ts, .mts, .cts, .flow files             │
│     - tsconfig, babel, jest, eslint configs                  │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  5. Clean native artifacts for current platform              │
│     - Remove prebuilds for other OS (linux/darwin on Windows)│
│     - Remove C/C++ source (.c, .h, .cpp, .cc, .o)           │
│     - Remove node-gyp build dirs                             │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  6. Strip large unnecessary directories                      │
│     - @keepkey/*/src (compiled to dist/)                     │
│     - ethers/dist + ethers/src.ts (main→lib/)                │
│     - rxjs (completely removed — unused)                     │
│     - lodash (completely removed — unused)                   │
│     - @cosmjs (completely removed — vendored)                │
│     - protobufjs (completely removed — google-protobuf used) │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  7. Strip unwanted nested packages                           │
│     - jest, ts-jest, node-notifier, .cache                   │
│     - Nested @keepkey/proto-tx-builder copies                │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  8. Deduplicate nested node_modules                          │
│     - Remove nested copies that match top-level version      │
│     - KEEP nested copies with different versions             │
│       (e.g. @noble/hashes@1.4.0 nested vs @1.8.0 top-level) │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  9. Collect missing transitive deps for preserved nested     │
│     - If nested pkg needs a dep not at top-level, copy it    │
│     - Skips @keepkey and protobufjs subtrees (huge dev deps) │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  10. Code-sign native binaries (macOS only)                  │
│      - Sign .node, .dylib, .so files with Developer ID       │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  11. Report final size                                       │
│      Output: build/_ext_modules/ (~XX MB)                    │
└──────────────────────────────────────────────────────────────┘
```

---

## The 37 Primary Externals

These are explicitly listed because they CANNOT be bundled by Bun.build():

```typescript
const EXTERNALS = [
    // --- KeepKey hardware wallet SDK ---
    '@keepkey/hdwallet-core',                // Core wallet abstractions
    '@keepkey/hdwallet-keepkey',             // KeepKey device protocol
    '@keepkey/hdwallet-keepkey-nodehid',     // USB HID transport (native .node)
    '@keepkey/hdwallet-keepkey-nodewebusb',  // WebUSB transport (native .node)
    '@keepkey/device-protocol',             // Protobuf message definitions
    '@keepkey/proto-tx-builder',            // Cosmos transaction builder

    // --- Native modules (contain .node binaries) ---
    'node-hid',                             // USB HID device enumeration
    'usb',                                  // Low-level USB access

    // --- Large packages better shipped separately ---
    'ethers',                               // Ethereum library (huge)

    // --- hdwallet-core dependencies ---
    'type-assertions',
    'eventemitter2',
    'eip-712',

    // --- hdwallet-keepkey dependencies ---
    '@ethereumjs/common',
    '@ethereumjs/tx',
    '@metamask/eth-sig-util',
    '@shapeshiftoss/bitcoinjs-lib',
    'bignumber.js',
    'bnb-javascript-sdk-nobroadcast',
    'crypto-js',
    'eip55',
    'icepick',
    'p-lazy',
    'semver',
    'tiny-secp256k1',                       // Has native .node prebuilds
]
```

From these 37, the transitive dependency walk discovers ~180+ packages total.

---

## File-Linked Packages

Six packages use `file:` protocol in `package.json` — they're local source directories, not npm packages:

```typescript
const FILE_LINKED_PACKAGES = {
    '@keepkey/hdwallet-core':              '../../modules/hdwallet/packages/hdwallet-core',
    '@keepkey/hdwallet-keepkey':           '../../modules/hdwallet/packages/hdwallet-keepkey',
    '@keepkey/hdwallet-keepkey-nodehid':   '../../modules/hdwallet/packages/hdwallet-keepkey-nodehid',
    '@keepkey/hdwallet-keepkey-nodewebusb':'../../modules/hdwallet/packages/hdwallet-keepkey-nodewebusb',
    '@keepkey/device-protocol':            '../../modules/hdwallet/.../node_modules/@keepkey/device-protocol',
    '@keepkey/proto-tx-builder':           '../../modules/proto-tx-builder-vendored',
}
```

These are resolved FIRST. If the file-linked path exists, it's used; otherwise falls back to `node_modules/`.

**Extra search locations** for hdwallet transitive dependencies:
```typescript
const EXTRA_NODE_MODULES = [
    '../../modules/hdwallet/node_modules',  // hdwallet monorepo deps
]
```

---

## What Gets Pruned

### Files Pruned (by name/extension)
| Pattern | Reason |
|---------|--------|
| `README.md`, `LICENSE`, `CHANGELOG.md` | Documentation — not needed at runtime |
| `.d.ts`, `.d.mts`, `.d.cts` | TypeScript declarations — Bun doesn't need them |
| `.map`, `.d.ts.map` | Source maps — not needed in production |
| `.ts`, `.mts`, `.cts` (non-declaration) | TypeScript source — already compiled |
| `.flow` | Flow type annotations |
| `tsconfig.json`, `.babelrc`, `jest.config.*` | Build/test config |
| `test/`, `tests/`, `__tests__/`, `spec/` | Test directories |

### Directories Stripped Completely
| Package | What's Removed | Why |
|---------|---------------|-----|
| `@keepkey/hdwallet-*/src` | TypeScript source | Compiled to `dist/` |
| `ethers/dist` + `ethers/src.ts` | UMD/ESM bundles (3.4MB) | Main entry → `lib/` |
| `rxjs` | Entire package | Unused at runtime |
| `lodash` | Entire package | Unused at runtime |
| `@cosmjs/*` | Entire scope | Vendored in proto-tx-builder |
| `cosmjs-types` | Entire package | Vendored in proto-tx-builder |
| `protobufjs` | Entire package | google-protobuf used instead |
| `keccak/build` | Build artifacts | Prebuilds used instead |
| `tiny-secp256k1/build` | Build artifacts | Prebuilds used instead |
| `libsodium/dist/modules-esm` | ESM duplicate | Main → `dist/modules/` |

### Nested Packages Stripped
| Package | Why |
|---------|-----|
| `jest`, `jest-cli`, `ts-jest` | Dev-only test framework |
| `node-notifier` | Dev-only (test notifications) |
| `.cache` | Build cache |
| Nested `@keepkey/proto-tx-builder` | Vendored top-level copy must win |

---

## The Relocatability Problem

### How It Should Work

```
Installed App:
C:\Program Files\KeepKey Vault\
├── Resources\app\bun\index.js       ← require("@keepkey/hdwallet-core")
├── Resources\app\node_modules\      ← packages found HERE
│   └── @keepkey\hdwallet-core\
```

Bun resolves `require()` by walking up from the requiring file:
1. `Resources/app/bun/node_modules/` — doesn't exist
2. `Resources/app/node_modules/` — FOUND

### How It Breaks

If `collect-externals.ts` **misses a dependency**, the app works in the build tree but fails when installed:

**In the build tree:**
```
projects/keepkey-vault/build/dev-win-x64/keepkey-vault-dev/
├── Resources/app/bun/index.js       ← require("@babel/runtime/...")
├── Resources/app/node_modules/      ← @babel/runtime NOT HERE
│
│   Bun walks up:
├── (no node_modules)
├── (no node_modules)
│   ...keeps walking...
└── projects/keepkey-vault/node_modules/ ← @babel/runtime FOUND HERE (dev install)
```

**When installed to Program Files:**
```
C:\Program Files\KeepKey Vault\
├── Resources/app/bun/index.js       ← require("@babel/runtime/...")
├── Resources/app/node_modules/      ← @babel/runtime NOT HERE
│
│   Bun walks up:
├── C:\Program Files\KeepKey Vault\node_modules\ — doesn't exist
├── C:\Program Files\node_modules\ — doesn't exist
├── C:\node_modules\ — doesn't exist
└── FAIL: Module not found
```

**The Worker silently dies.** No error message, no crash dialog — the Bun Worker that loads `index.js` simply fails to start, and the app shows a blank window or nothing at all.

### How to Diagnose

Check if a package is missing from the collected externals:

```bash
# List what's in the built node_modules:
ls projects/keepkey-vault/build/dev-win-x64/keepkey-vault-dev/Resources/app/node_modules/

# Check if a specific package exists:
ls projects/keepkey-vault/build/dev-win-x64/keepkey-vault-dev/Resources/app/node_modules/@babel/runtime

# Run from the build directory to see if it works there:
cd projects/keepkey-vault/build/dev-win-x64/keepkey-vault-dev
./bin/launcher.exe

# Copy to a completely isolated directory and test:
cp -r projects/keepkey-vault/build/dev-win-x64/keepkey-vault-dev /tmp/vault-test/
cd /tmp/vault-test/
./bin/launcher.exe
# If this fails but the above works → missing dependencies
```

### How to Fix Missing Dependencies

Add the missing package to the `EXTERNALS` array in `collect-externals.ts`:

```typescript
const EXTERNALS = [
    // ... existing entries ...
    '@babel/runtime',  // ← ADD missing transitive dependency
]
```

Or, if it's a transitive dependency that should be discovered automatically, check why `addDeps()` didn't find it:

```typescript
function addDeps(pkg: string) {
    const pjPath = join(nmSource, pkg, 'package.json')
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    // Only reads "dependencies", NOT "peerDependencies" or "optionalDependencies"
    for (const dep of Object.keys(pj.dependencies || {})) {
        // ...
    }
}
```

**Common reasons a dep is missed:**
1. It's in `peerDependencies` (not crawled)
2. It's in `optionalDependencies` (not crawled)
3. It's only in `devDependencies` of the root project but required at runtime
4. The `package.json` couldn't be read (file-linked package with different structure)
5. It was aggressively stripped (check `STRIP_DIRS` list)

---

## Expected Output

When `collect-externals.ts` runs successfully:

```
[collect-externals] 183 packages to copy:
  @babel/runtime
  @ethereumjs/common
  @ethereumjs/tx
  @keepkey/device-protocol
  @keepkey/hdwallet-core
  @keepkey/hdwallet-keepkey
  ... (183 total)
[collect-externals] Copied 183 packages to build/_ext_modules
[collect-externals] Pruned 2847 files/dirs (12.3MB removed)
[collect-externals] Cleaned native artifacts (7.1MB removed)
  Stripped: @keepkey/hdwallet-core/src (0.8MB)
  Stripped: ethers/dist (3.4MB)
  Stripped: rxjs (2.1MB)
  ...
[collect-externals] Stripped 14.2MB from large directories
[collect-externals] Stripped duplicate nested node_modules (kept version-differing deps)
  Keeping nested: @noble/hashes@1.4.0 (top-level: 1.8.0)
[collect-externals] Collected 3 extra deps for nested packages: through2, isarray, process-nextick-args
[collect-externals] ELECTROBUN_DEVELOPER_ID not set, skipping native binary signing
[collect-externals] Final size: 42.7MB
```

---

## Electrobun Config Connection

The `external` array in `electrobun.config.ts` must match what `collect-externals.ts` collects:

```
electrobun.config.ts build.bun.external:     What Bun.build() SKIPS (leaves as require())
collect-externals.ts EXTERNALS:              What gets COLLECTED into node_modules/
electrobun.config.ts build.copy:             What gets COPIED into the app bundle
```

```
electrobun.config.ts                    collect-externals.ts
┌─────────────────┐                    ┌──────────────────────┐
│ external: [     │                    │ EXTERNALS = [        │
│   "@keepkey/*", │  ← must match →   │   "@keepkey/*",      │
│   "node-hid",   │                    │   "node-hid",        │
│   "usb",        │                    │   "usb",             │
│   "ethers",     │                    │   "ethers",          │
│   ...           │                    │   ...                │
│ ]               │                    │   + transitive deps  │
│                 │                    │ ]                    │
│ copy: {         │                    │                      │
│   "_ext_modules"│ ← copies output → │ Output:              │
│   → "node_mods" │                    │ build/_ext_modules/  │
│ }               │                    │                      │
└─────────────────┘                    └──────────────────────┘
```

**If a package is in `external` but NOT collected**: The `require()` will fail at runtime.
**If a package is collected but NOT in `external`**: It's bundled into `index.js` AND shipped in `node_modules/` (wasteful but works).

---

## Debugging Tips

### Check what's actually in the bundle
```bash
# After building, inspect the output:
ls -la projects/keepkey-vault/build/_ext_modules/ | wc -l
# Should be ~180+ directories

# Check specific package:
cat projects/keepkey-vault/build/_ext_modules/@keepkey/hdwallet-core/package.json | grep version

# Check native prebuilds exist for Windows:
ls projects/keepkey-vault/build/_ext_modules/node-hid/prebuilds/
# Should have win32-x64/ directory

ls projects/keepkey-vault/build/_ext_modules/usb/prebuilds/
# Should have win32-x64/ directory
```

### Verify the build output has node_modules
```bash
# After electrobun build:
ls projects/keepkey-vault/build/dev-win-x64/keepkey-vault-dev/Resources/app/node_modules/
# Should mirror build/_ext_modules/
```

### Test relocatability
```bash
# Copy the entire build to a clean location:
cp -r build/dev-win-x64/keepkey-vault-dev /tmp/vault-test/

# Run from there:
cd /tmp/vault-test && ./bin/launcher.exe

# If it fails: a dependency is missing from collect-externals
```
