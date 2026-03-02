# KeepKey Vault — Build & Distribution Guide

## Overview

KeepKey Vault is built with [Electrobun](https://electrobun.dev) — a desktop framework using Bun as the main process and the system WebView for the UI. The build pipeline produces a signed, notarized macOS DMG.

**Architecture**: Vite (frontend) → Bun.build (backend) → collect-externals (native deps) → Electrobun (packaging) → prune-app-bundle (post-build dedup) → DMG (distribution)

## Quick Start

```bash
# Development (from monorepo root)
make dev

# Full signed production build → DMG
make build-signed
```

## Prerequisites

- **Bun** >= 1.3.5
- **Yarn** (for hdwallet monorepo)
- **Xcode Command Line Tools** (`xcode-select --install`)
- **Apple Developer ID** certificate in Keychain (for signing)
- **zstd** (`brew install zstd`) — for tar.zst extraction

### Environment Variables (Signing)

Create a `.env` file in the monorepo root:

```bash
ELECTROBUN_DEVELOPER_ID="KEY HODLERS LLC"
ELECTROBUN_TEAMID="DR57X8Z394"
ELECTROBUN_APPLEID="your@apple.id"
ELECTROBUN_APPLEIDPASS="app-specific-password"
```

> **Never commit `.env` files.** Generate an app-specific password at [appleid.apple.com](https://appleid.apple.com).

## Build Pipeline

The full `make build-signed` pipeline runs: `build-stable` → `prune-bundle` → `dmg`.

### Stage 1: Module Builds (`make modules-build`)

Builds local submodule dependencies from source:

1. **proto-tx-builder** (`modules/proto-tx-builder/`): `bun install && bun run build`
2. **hdwallet** (`modules/hdwallet/`): `yarn install && yarn build` (lerna monorepo, ~6s)

These are referenced as `file:` dependencies in `package.json`.

> **CRITICAL**: hdwallet must be on `master` (or `vault-v1` branch) which has the lodash/rxjs removal commit (`179c5668`). Without this, the build scripts correctly strip lodash/rxjs but the code still imports them → runtime crash.

### Stage 2: Vault Install (`bun install`)

Installs all dependencies. The `postinstall` hook runs `scripts/patch-electrobun.sh` to patch Electrobun's zip handling (see [ENOBUFS Workaround](#enobufs-workaround)).

### Stage 3: Vite Build (`vite build`)

Builds the React frontend (Chakra UI 3.0) from `src/mainview/` into `dist/`.

**Critical**: `base: './'` in `vite.config.ts` generates relative asset paths. Without this, assets fail to load under Electrobun's `views://` protocol (absolute paths like `/assets/...` resolve to the wrong origin).

### Stage 4: Collect Externals (`bun scripts/collect-externals.ts`)

Native addons and protobuf packages can't be bundled by Bun — they're marked `external` in `electrobun.config.ts`. This script collects them into `build/_ext_modules/`.

**What it does**:

1. **Dependency tree walk**: Collects all transitive deps from the EXTERNALS list, filtering out ~100 dev-time packages via DEV_BLOCKLIST (jest, babel, istanbul, ts-proto, etc.)
2. **Copy**: Each package from `node_modules/` → `build/_ext_modules/`
3. **Version-aware nested dedup**: Discovers nested `node_modules/` in each package:
   - **Same version as top-level** → skip (duplicate)
   - **Different version** → copy to `pkg/node_modules/nested-pkg` (required by parent)
   - Also collects the nested package's own deps at top-level
4. **@keepkey/* cleanup**: Strips `node_modules/` from `@keepkey/*` packages (lerna monorepo artifacts from `file:` resolution — all their deps are already at top-level)
5. **Prune**: Removes docs, tests, `.d.ts`, source maps, TypeScript source, C/C++ build artifacts, non-macOS prebuilds
6. **Directory strip**: Removes known-large unnecessary directories (protobufjs/cli, ethers/dist, etc.)
7. **Banned package removal**: Recursively removes `node-notifier`, `growly`, `is-wsl` (contain unsigned macOS binaries that break notarization)
8. **Code signing**: Signs all `.node`, `.dylib`, `.so` binaries AND extensionless Mach-O binaries with Apple Developer ID

**Bundle size**: ~38MB on disk (~237 packages)

> See [collect-externals-guide.md](collect-externals-guide.md) for safety rules and debugging.
> See [retro-noble-hashes-breakage.md](retro-noble-hashes-breakage.md) for why blind nested stripping is dangerous.

### Stage 5: Electrobun Build (`bun scripts/build-signed.ts stable`)

Runs `electrobun build --env=stable` with a custom `scripts/zip` shim on PATH.

Electrobun:
1. Bundles the Bun backend (`src/bun/index.ts` → single JS file)
2. Copies files specified in `electrobun.config.ts` `build.copy`:
   - `dist/index.html` → `views/mainview/index.html`
   - `dist/assets` → `views/mainview/assets`
   - `build/_ext_modules` → `node_modules`
3. Code-signs all Mach-O binaries in the `.app` bundle
4. Notarizes the `.app` with Apple
5. Produces a `.app.tar.zst` artifact in `artifacts/`

### Stage 6: Prune App Bundle (`make prune-bundle`)

`scripts/prune-app-bundle.ts` operates on the final `.app.tar.zst` — a second pass that catches anything collect-externals missed:

1. Extracts the tar.zst → temporary `.app` directory
2. **Version-aware nested dedup** (same logic as collect-externals): only removes nested deps whose version matches top-level
3. Prunes `.d.ts`, `.ts`, `.map`, `README`, `CHANGELOG`, `LICENSE` files
4. Strips known large directories (protobufjs, ethers, libsodium ESM, etc.)
5. Re-signs all native `.node` binaries
6. **Re-signs the entire `.app` with `entitlements.plist`** — JIT, unsigned executable memory, dyld env vars, and library validation bypass (all required for Bun runtime)
7. Repackages into tar.zst

> **CRITICAL**: The `entitlements.plist` step was added in v1.0.1. Without it, macOS Sequoia kills the Bun process on launch (hardened runtime blocks JIT which Bun requires).

### Stage 7: DMG Creation (`make dmg`)

Creates a distributable DMG from the pruned app:

1. Extracts `.app` from the `.app.tar.zst` archive
2. Verifies codesign on extracted app
3. Creates a DMG with `hdiutil` (UDZO compression)
4. Signs the DMG
5. Notarizes the DMG with Apple
6. Staples the notarization ticket

**Output**: `artifacts/KeepKey-Vault-{VERSION}-{ARCH}.dmg` (~52MB)

> **Why not use Electrobun's built-in DMG?** Electrobun's zig-zstd self-extractor has a bug where binary files aren't extracted properly on macOS Sequoia. The custom DMG pipeline works around this.

## Signing Deep Dive

### What Gets Signed and When

The build has **three signing passes** to satisfy Apple notarization:

| Pass | Script | What | Why |
|------|--------|------|-----|
| 1 | `collect-externals.ts` | All `.node`, `.dylib`, `.so`, extensionless Mach-O binaries in `build/_ext_modules/` | Native addons must be signed before Electrobun packages them |
| 2 | `prune-app-bundle.ts` | All native binaries in the extracted `.app` | Re-sign after pruning modifies the bundle |
| 3 | `prune-app-bundle.ts` | The entire `.app` bundle with `--entitlements entitlements.plist` | Hardened runtime + JIT entitlements for Bun |

### Entitlements (`entitlements.plist`)

```xml
<key>com.apple.security.cs.allow-jit</key>             <!-- Bun JIT compiler -->
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>  <!-- Bun runtime -->
<key>com.apple.security.cs.disable-library-validation</key>        <!-- Native addons -->
<key>com.apple.security.cs.allow-dyld-environment-variables</key>  <!-- Module loading -->
```

All four are required. Missing `allow-jit` causes the app to be killed immediately on macOS Sequoia.

### Extensionless Mach-O Detection

Some packages ship binary executables without file extensions. `collect-externals.ts` detects these by reading the first 4 bytes and checking for Mach-O magic numbers:

- `0xFEEDFACE` / `0xFEEDFACF` — 32/64-bit Mach-O
- `0xCEFAEDFE` / `0xCFFAEDFE` — Reverse byte order
- `0xCAFEBABE` — Universal binary

Unsigned Mach-O binaries cause notarization to fail with a cryptic error.

### Common Signing Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| Notarization rejects with "unsigned binary" | Nested `node_modules/` contains unsigned Mach-O | Check banned packages list, run `find` for unsigned binaries (see Troubleshooting) |
| App killed on launch (no error) | Missing JIT entitlement | Verify `entitlements.plist` is applied in `prune-app-bundle.ts` |
| `codesign: resource fork, Finder information, or similar detritus not allowed` | `.DS_Store` or extended attributes in bundle | Add `xattr -cr` step before signing |
| Stapling fails after notarization succeeds | Network issue or Apple CDN delay | Retry `xcrun stapler staple` after a few minutes |

## Makefile Targets

| Target | Description |
|--------|-------------|
| `make vault` | Build modules + install deps + run dev mode |
| `make dev` | Build and run in dev mode |
| `make dev-hmr` | Dev with Vite HMR (hot module reload) |
| `make build` | Development build (no signing) |
| `make build-stable` | Production build with signing + notarization |
| `make build-signed` | Full pipeline: build → prune → DMG → sign → notarize → staple |
| `make prune-bundle` | Prune app bundle (version-aware dedup, strip bloat, re-sign with entitlements) |
| `make dmg` | Create DMG from existing build artifacts |
| `make upload-dmg` | Upload signed DMG to existing CI-created draft release |
| `make release` | Full release: build-signed + create new GitHub release |
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

## CI / Release Workflow

### Linux (CI — GitHub Actions)

CI builds Linux x64 only (`.github/workflows/build.yml`). macOS and Windows are built locally because:
- macOS requires Apple Developer ID in Keychain (can't run in CI without self-hosted runner)
- Windows Electrobun support is experimental (D:\ drive path bug)

### macOS Release (Local)

```bash
# Option A: Full release (build + create GitHub release)
make release

# Option B: Upload to existing CI draft release
make build-signed    # Build locally
make upload-dmg      # Upload DMG to CI's draft release
```

`make upload-dmg` also uploads `stable-*-update.json` and `stable-*.app.tar.zst` if present (for Electrobun auto-updates).

## Known Workarounds

### ENOBUFS Workaround

Electrobun's compiled Zig CLI invokes `zip` via Bun's `execSync` with a 1MB `maxBuffer`. With ~5700+ files, zip output exceeds this buffer → `ENOBUFS`.

**Two-layer fix**:
1. **`scripts/zip`** — Shim that adds `-q` (quiet) to suppress per-file output
2. **`scripts/build-signed.ts`** — Prepends `scripts/` to PATH so the shim is found before `/usr/bin/zip`
3. **`scripts/patch-electrobun.sh`** — Patches Electrobun's CLI source to add `-q` and increase `maxBuffer` to 50MB (runs as `postinstall`)

### Vite `base: './'`

Electrobun serves WebView content via `views://` protocol. Vite's default `base: '/'` generates absolute paths (`/assets/index.js`) which resolve to `views://assets/` instead of `views://mainview/assets/`. Setting `base: './'` fixes this.

### Version-Aware Nested Dedup (v1.0.1 Fix)

**Problem (v1.0.0)**: Blind stripping of ALL nested `node_modules/` killed `@noble/hashes@1.4.0` (required by `ethereum-cryptography@2.2.1`), while top-level had `@noble/hashes@1.8.0` with incompatible API changes. App crashed silently inside Electrobun's Worker before any window opened.

**Fix**: Both `collect-externals.ts` and `prune-app-bundle.ts` now compare `package.json` versions:
- Same version as top-level → safe to remove (duplicate)
- Different version → MUST keep (parent needs this specific version)

See [retro-noble-hashes-breakage.md](retro-noble-hashes-breakage.md) for the full incident report.

### DEV_BLOCKLIST

`collect-externals.ts` maintains a blocklist of ~100 dev-time packages (jest, babel, istanbul, ts-proto, etc.) that get pulled into the dependency tree via `file:` resolution of hdwallet/proto-tx-builder. Without the blocklist these add ~50MB of test infrastructure to the production bundle.

## Troubleshooting

### Build fails with ENOBUFS
The zip shim isn't being used. Verify:
```bash
which zip  # Should show scripts/zip during build
cat scripts/zip  # Should contain: exec /usr/bin/zip -q "$@"
```

### Notarization fails with "unsigned binary"
A nested `node_modules/` or banned package contains an unsigned Mach-O binary:
```bash
find build/_ext_modules -type f | while read f; do
  file "$f" | grep -q "Mach-O" && ! codesign -v "$f" 2>/dev/null && echo "UNSIGNED: $f"
done
```
Fix: add the package to `BANNED_PACKAGES` in `collect-externals.ts` or ensure the signing loop catches it.

### App killed immediately on macOS Sequoia (no error)
Missing JIT entitlement. Verify:
```bash
codesign -d --entitlements :- /path/to/KeepKey\ Vault.app
```
Should show `com.apple.security.cs.allow-jit`. If missing, check that `prune-app-bundle.ts` applies `entitlements.plist`.

### UI doesn't render (blank window)
Check `vite.config.ts` has `base: './'`. Verify in `dist/index.html` that asset paths are relative (`./assets/...`), not absolute (`/assets/...`).

### Module not found at runtime
A package's `main` field points to a pruned directory. Check the package's `package.json` to ensure its entry point still exists after pruning. Common case: packages using `"main": "./src/index.js"`.

### App opens but crashes immediately
Run from terminal to see the error:
```bash
/path/to/KeepKey\ Vault.app/Contents/MacOS/launcher
```
Or bypass Electrobun's Worker isolation entirely:
```bash
cd build/dev-macos-arm64/keepkey-vault-dev.app/Contents/MacOS
timeout 10 ./bun ../Resources/app/bun/index.js 2>&1
```

### Bundle too large
Run `du -sh build/_ext_modules/` (expected ~38MB). Check collect-externals output for "Keeping nested" lines. Consider `package.json` `overrides` to align versions.

## Security & Audit

Run `make audit` to generate:
- `artifacts/deps.runtime.json` — All runtime dependencies with versions and sizes
- `artifacts/deps.install-scripts.txt` — Packages with install scripts (security review)
- `artifacts/sbom.cdx.json` — CycloneDX Software Bill of Materials

## File Reference

```
projects/keepkey-vault/
  electrobun.config.ts       # Electrobun app config (externals, copy rules, signing)
  vite.config.ts             # Vite frontend build config (base: './')
  package.json               # Dependencies and build scripts
  entitlements.plist          # macOS entitlements (JIT, unsigned memory, dyld, library validation)
  scripts/
    collect-externals.ts     # Native module collector + pruner + signer (DEV_BLOCKLIST, version-aware dedup)
    prune-app-bundle.ts      # Post-build pruner on .app.tar.zst (version-aware dedup + entitlements re-sign)
    build-signed.ts          # Electrobun build wrapper with zip shim
    patch-electrobun.sh      # Patches Electrobun CLI for large bundles
    zip                      # Quiet zip shim (prevents ENOBUFS)
    audit-deps.ts            # Dependency audit + SBOM generator
  artifacts/                 # Build output (gitignored)
    KeepKey-Vault-*.dmg      # Signed, notarized DMG
    *.app.tar.zst            # Electrobun compressed app (post-prune)
    deps.runtime.json        # Dependency manifest
    sbom.cdx.json            # CycloneDX SBOM
  docs/
    collect-externals-guide.md   # Safety rules for collect-externals changes
    retro-noble-hashes-breakage.md  # v1.0.0 crash incident report
```
