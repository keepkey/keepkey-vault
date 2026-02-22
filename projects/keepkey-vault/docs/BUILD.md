# KeepKey Vault v11 - Build & Distribution Guide

## Overview

KeepKey Vault is built with [Electrobun](https://electrobun.dev) — a desktop framework using Bun as the main process and the system WebView for the UI. The build pipeline produces a signed, notarized macOS DMG.

**Architecture**: Vite (frontend) + Bun.build (backend) + Electrobun (packaging) + Apple codesign/notarize

## Quick Start

```bash
# Development (from monorepo root)
make dev

# Full signed production build
make build-signed
```

## Prerequisites

- **Bun** >= 1.3.5
- **Yarn** (for hdwallet monorepo)
- **Xcode Command Line Tools** (`xcode-select --install`)
- **Apple Developer ID** certificate in Keychain (for signing)
- **zstd** (`brew install zstd`) — for DMG extraction

### Environment Variables (Signing Only)

Create a `.env` file in the monorepo root:

```bash
ELECTROBUN_DEVELOPER_ID="KEY HODLERS LLC"
ELECTROBUN_TEAMID="DR57X8Z394"
ELECTROBUN_APPLEID="your@apple.id"
ELECTROBUN_APPLEIDPASS="app-specific-password"
```

> **Never commit `.env` files.** Generate an app-specific password at [appleid.apple.com](https://appleid.apple.com).

## Build Pipeline

The full `make build-signed` pipeline executes these stages in order:

### Stage 1: Module Builds (`make modules-build`)

Builds local submodule dependencies from source:

1. **proto-tx-builder** (`modules/proto-tx-builder/`): `bun install && bun run build` (TypeScript → dist/)
2. **hdwallet** (`modules/hdwallet/`): `yarn install && yarn build` (lerna monorepo, ~6s)

These are referenced as `file:` dependencies in `package.json`.

### Stage 2: Vault Install (`bun install`)

Installs all dependencies. The `postinstall` hook runs `scripts/patch-electrobun.sh` to patch Electrobun's zip handling (see [ENOBUFS Workaround](#enobufs-workaround) below).

### Stage 3: Vite Build (`vite build`)

Builds the React frontend (Chakra UI 3.0) from `src/mainview/` into `dist/`.

**Critical**: `base: './'` in `vite.config.ts` generates relative asset paths. Without this, assets fail to load under Electrobun's `views://` protocol (absolute paths like `/assets/...` resolve to the wrong origin).

Output:
- `dist/index.html` — entry point
- `dist/assets/` — JS/CSS chunks

### Stage 4: Collect Externals (`bun scripts/collect-externals.ts`)

Native addons and protobuf packages can't be bundled by Bun — they're marked `external` in `electrobun.config.ts`. This script collects them and all transitive dependencies into `build/_ext_modules/` for inclusion in the app bundle.

**What it does**:
1. Walks the dependency tree of all EXTERNALS (~274 packages)
2. Copies each package from `node_modules/` to `build/_ext_modules/`
3. Strips ALL nested `node_modules/` (forces flat resolution, removes devDep bloat)
4. Prunes docs, tests, source maps, `.d.ts`, TypeScript source, C/C++ build artifacts
5. Removes non-macOS prebuilds (linux, win32)
6. Strips large directories (protobufjs/cli, rxjs/dist/bundles, ethers/dist, etc.)
7. Code-signs all `.node`, `.dylib`, `.so` native binaries (if `ELECTROBUN_DEVELOPER_ID` is set)

**Bundle size**: ~54MB on disk (~274 packages, ~5700 files)

> **Why strip nested `node_modules`?** Bun copies `file:` deps with their own `node_modules/`, creating 64MB+ of duplicated packages including dev tools (`jest`, `node-notifier`) with unsigned Mach-O binaries that break Apple notarization.

### Stage 5: Electrobun Build (`bun scripts/build-signed.ts stable`)

Runs `electrobun build --env=stable` with a custom `scripts/zip` shim on PATH (see [ENOBUFS Workaround](#enobufs-workaround)).

Electrobun:
1. Bundles the Bun backend (`src/bun/index.ts` → single JS file)
2. Copies files specified in `electrobun.config.ts` `build.copy`:
   - `dist/index.html` → `views/mainview/index.html`
   - `dist/assets` → `views/mainview/assets`
   - `build/_ext_modules` → `node_modules`
3. Code-signs all Mach-O binaries in the `.app` bundle
4. Notarizes the `.app` with Apple
5. Produces a `.app.tar.zst` artifact

### Stage 6: DMG Creation (`make dmg`)

Creates a distributable DMG from the notarized app:

1. Extracts `.app` from the `.app.tar.zst` archive
2. Verifies codesign on extracted app
3. Creates a DMG with `hdiutil` (UDZO compression)
4. Signs the DMG itself
5. Notarizes the DMG with Apple
6. Staples the notarization ticket to the DMG

**Output**: `artifacts/KeepKey-Vault-{VERSION}-{ARCH}.dmg` (~100MB)

> **Why not use Electrobun's built-in DMG?** Electrobun's zig-zstd self-extractor has a bug where binary files aren't extracted properly. The custom DMG pipeline works around this by extracting from the tar.zst and creating a standard macOS DMG.

## Makefile Targets

| Target | Description |
|--------|-------------|
| `make vault` | Build modules + install deps + run dev mode |
| `make dev` | Build and run in dev mode |
| `make dev-hmr` | Dev with Vite HMR (hot module reload) |
| `make build` | Development build (no signing) |
| `make build-stable` | Production build with signing + notarization |
| `make build-signed` | Full pipeline: build → DMG → sign → notarize → staple |
| `make dmg` | Create DMG from existing build artifacts |
| `make modules-build` | Build hdwallet + proto-tx-builder from source |
| `make modules-clean` | Clean module build artifacts |
| `make audit` | Generate dependency manifest + SBOM |
| `make sign-check` | Verify signing env vars are configured |
| `make verify` | Verify .app bundle signature + Gatekeeper |
| `make clean` | Remove all build artifacts and node_modules |

## Electrobun Build Environments

| Flag | Purpose | Signing |
|------|---------|---------|
| `--env=dev` | Development (Vite HMR support) | None |
| `--env=canary` | Pre-release testing | Signed + notarized |
| `--env=stable` | Production release | Signed + notarized |

## Known Workarounds

### ENOBUFS Workaround

Electrobun's compiled Zig CLI invokes `zip` via Bun's `execSync` with a 1MB `maxBuffer`. With ~5700+ files in the app bundle, the zip output exceeds this buffer causing `ENOBUFS`.

**Two-layer fix**:
1. **`scripts/zip`** — A shim that intercepts zip calls and adds `-q` (quiet flag) to suppress per-file output
2. **`scripts/build-signed.ts`** — Prepends `scripts/` to PATH so the shim is found before `/usr/bin/zip`
3. **`scripts/patch-electrobun.sh`** — Patches Electrobun's CLI source to add `-q` and increase `maxBuffer` to 50MB (runs as `postinstall`)

### Vite `base: './'`

Electrobun serves WebView content via the `views://` protocol from `Contents/Resources/app/views/mainview/`. Vite's default `base: '/'` generates absolute paths (`/assets/index.js`) which resolve to `views://assets/` instead of `views://mainview/assets/`. Setting `base: './'` generates relative paths (`./assets/index.js`) that resolve correctly.

### Nested `node_modules` Stripping

Bun's `file:` dependency resolution copies the entire local package directory including its own `node_modules/`. These nested copies contain:
- Duplicated packages (hdwallet-core 5.4MB x4, rxjs, cosmjs, etc. = ~64MB)
- Dev dependencies (jest, babel, node-notifier with unsigned Mach-O binaries)

The `collect-externals.ts` script strips ALL nested `node_modules/` and relies on the flat top-level resolution instead.

### `src/` Not Pruned

Many packages (e.g., `bip32`) set `"main": "./src/index.js"` — their published artifact IS the `src/` directory. The prune step explicitly preserves `src/` directories.

## Native Binary Signing

Apple notarization requires ALL Mach-O binaries to be signed with a Developer ID certificate and hardened runtime. The `collect-externals.ts` script signs:
- `.node` files (native addons: node-hid, usb, tiny-secp256k1, keccak, etc.)
- `.dylib` files
- `.so` files

Approximately 17 native binaries are signed during the collect step.

## Security & Audit

Run `make audit` to generate:
- `artifacts/deps.runtime.json` — All runtime dependencies with versions and sizes
- `artifacts/deps.install-scripts.txt` — Packages with install scripts (security review)
- `artifacts/sbom.cdx.json` — CycloneDX Software Bill of Materials

## Troubleshooting

### Build fails with ENOBUFS
The zip shim isn't being used. Verify:
```bash
which zip  # Should show scripts/zip during build
cat scripts/zip  # Should contain: exec /usr/bin/zip -q "$@"
```

### Notarization fails with "unsigned binary"
A nested `node_modules/` contains an unsigned Mach-O binary. Run:
```bash
# Find unsigned binaries in the build
find build/_ext_modules -type f | while read f; do
  file "$f" | grep -q "Mach-O" && ! codesign -v "$f" 2>/dev/null && echo "UNSIGNED: $f"
done
```
Fix: ensure `collect-externals.ts` strips nested `node_modules/` and signs all native binaries.

### UI doesn't render (blank window)
Check `vite.config.ts` has `base: './'`. Verify in `dist/index.html` that asset paths are relative (`./assets/...`), not absolute (`/assets/...`).

### Module not found at runtime
A package's `main` field points to a pruned directory. Check the package's `package.json` to ensure its entry point still exists after pruning. Common case: packages using `"main": "./src/index.js"`.

### App opens but crashes immediately
Run from terminal to see the error:
```bash
/path/to/KeepKey\ Vault.app/Contents/MacOS/launcher
```

## File Reference

```
projects/keepkey-vault/
  electrobun.config.ts     # Electrobun app config (externals, copy rules, signing)
  vite.config.ts           # Vite frontend build config (base: './')
  package.json             # Dependencies and build scripts
  scripts/
    collect-externals.ts   # Native module collector + pruner + signer
    build-signed.ts        # Electrobun build wrapper with zip shim
    patch-electrobun.sh    # Patches Electrobun CLI for large bundles
    zip                    # Quiet zip shim (prevents ENOBUFS)
    audit-deps.ts          # Dependency audit + SBOM generator
  artifacts/               # Build output (gitignored)
    KeepKey-Vault-*.dmg    # Signed, notarized DMG
    *.app.tar.zst          # Electrobun compressed app
    deps.runtime.json      # Dependency manifest
    sbom.cdx.json          # CycloneDX SBOM
```
