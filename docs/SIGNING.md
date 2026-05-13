# macOS Code Signing & Dual-Architecture Build Pipeline

## Overview

KeepKey Vault ships signed+notarized DMGs for two macOS architectures:

| Architecture | Build Method | Electrobun Source | Bun Version |
|-------------|-------------|-------------------|-------------|
| **arm64** (Apple Silicon) | Native build on `macos-14` runner | Upstream Electrobun | 1.3.5 |
| **x86_64** (Intel) | Binary swap from custom fork | `BitHighlander/electrobun` | 1.1.20 |

**Signing stays local.** CI builds unsigned artifacts. A developer with Apple credentials runs `make sign-release` to sign both architectures, create DMGs, notarize, and upload.

## Why a Custom Electrobun Fork for x64

Standard Electrobun x64 builds have two problems on older Intel Macs:

1. **resign-swizzle crash**: `libNativeWrapper.dylib` contains `resignKeyWindow` method swizzling that crashes on macOS 12 when the app loses focus
2. **Bun version**: Bun 1.3.x dropped macOS 12 support; Bun 1.1.20 is the last compatible version

The fork (`BitHighlander/electrobun @ v1.16.1-keepkey.1`) provides pre-built x64 core binaries without resign-swizzle and with Bun 1.1.20.

## The Entitlements Requirement

The Bun runtime requires JIT compilation. On macOS with hardened runtime (required for notarization), JIT is blocked unless the binary has `com.apple.security.cs.allow-jit` in its entitlements.

**Critical**: `codesign` on a `.app` bundle only applies `--entitlements` to the **main executable** (`CFBundleExecutable` = launcher). The `bun` binary must be signed individually with entitlements, or it will crash with SIGTRAP on launch.

The entitlements file (`projects/keepkey-vault/entitlements.plist`) contains:
- `allow-jit` — JIT compilation (required for Bun)
- `allow-unsigned-executable-memory` — dynamic code execution
- `disable-library-validation` — load unsigned dylibs
- `allow-dyld-environment-variables` — runtime environment control

Do not add `com.apple.security.device.camera` here. Camera permission for QR
scanning is handled by `NSCameraUsageDescription` in `Info.plist`; adding the
sandbox camera entitlement to this Developer ID app makes the entitlement blob
invalid, and macOS ignores the whole blob.

## Three Signing Paths

### Path 1: `make build-signed` (local full build)

For development/testing. Builds everything locally with signing.

```
make build-signed
```

Pipeline: `build-stable` → `audit` → `prune-bundle` → `dmg`

- Electrobun signs during build (`codesign: true` when CI is not set)
- `prune-app-bundle.ts` re-signs after pruning (invalidated signatures)
- `dmg` target creates DMG, signs, notarizes, staples

### Path 2: `make sign-release` (sign CI artifacts — production)

The production release flow. CI builds unsigned, developer signs locally.

```
make sign-release
```

Pipeline:
1. Downloads arm64 + x64 tar.zst from GitHub draft release
2. For each architecture, calls `_sign-one-dmg` which:
   - Extracts .app from tar.zst
   - Verifies architecture with `lipo`
   - Calls `scripts/sign-macos-app.sh` (signs all binaries with entitlements)
   - Re-packs signed tar.zst (for auto-update)
   - Creates DMG, signs DMG, notarizes, staples
3. Uploads signed DMGs + tar.zst to draft release

### Path 3: `make dmg` (standalone DMG from existing build)

Creates a DMG from an already-signed tar.zst artifact.

```
make dmg
```

Assumes the .app is already signed (from Path 1 or 2). Only signs the DMG file itself.

## CI Workflow (`.github/workflows/build.yml`)

CI runs on push to `develop`, `release/*`, or `v*` tags.

### arm64 Build
- Runs on `macos-14` (Apple Silicon)
- Builds modules, zcash-cli, Vite frontend, Electrobun app
- Produces unsigned `stable-macos-arm64-keepkey-vault.app.tar.zst`

### x64 Variant (Binary Swap)
- Downloads pre-built x64 core from `BitHighlander/electrobun @ v1.16.1-keepkey.1`
- Extracts arm64 .app, swaps 4 binaries: `launcher`, `bun`, `libNativeWrapper.dylib`, `libasar.dylib`
- Removes `zcash-cli` (Zcash shielded not supported on Intel)
- Verifies all swapped binaries are x86_64
- Verifies `libNativeWrapper.dylib` has no resign-swizzle symbols
- Produces unsigned `stable-macos-x64-keepkey-vault.app.tar.zst`

### Draft Release
- Creates draft GitHub release with all artifacts
- Developer signs locally with `make sign-release`

## Signing Script: `scripts/sign-macos-app.sh`

Single source of truth for signing any `.app` bundle. Signs inside-out:

1. Native addons (`.node`, `.dylib`, `.so`) in Resources/ — no entitlements
2. All Mach-O binaries in `Contents/MacOS/` — **each with entitlements**
3. The `.app` bundle itself — with entitlements
4. Verifies with `codesign --verify --deep --strict`
5. Spot-checks that bun has `allow-jit`

The same pattern is implemented in `prune-app-bundle.ts` for the local build path.

## Verification

```bash
# Check all signed artifacts have entitlements
make verify-entitlements

# Manual check on a specific binary
codesign -d --entitlements :- path/to/keepkey-vault.app/Contents/MacOS/bun

# Check Gatekeeper assessment
spctl --assess --type execute -vvv path/to/keepkey-vault.app
```

## Troubleshooting

### App crashes with SIGTRAP on launch
**Cause**: bun binary missing `allow-jit` entitlement.
**Fix**: Re-sign with `make sign-release` or `scripts/sign-macos-app.sh`.
**Verify**: `codesign -d --entitlements :- .../Contents/MacOS/bun | grep allow-jit`

### "Can't be opened" Gatekeeper dialog
**Cause**: Quarantine flag or missing notarization.
**Fix**: Right-click → Open, or: `xattr -cr /path/to/app.dmg`

### x64 app crashes on macOS 12
**Cause**: `libNativeWrapper.dylib` has resign-swizzle symbols.
**Verify**: `nm .../libNativeWrapper.dylib | grep resignKeyWindow` (should find nothing)
**Fix**: Rebuild x64 core from fork: `make build-electrobun-x64-core`

## Building the x64 Electrobun Core

If you need to update the pre-built x64 binaries:

```bash
# Cross-compile from ARM64 Mac
make build-electrobun-x64-core

# Publish to fork
make publish-electrobun-x64-core
```

Prerequisites: `cd modules/electrobun/package && bun install && bun build.ts` (vendors CEF, Zig, etc.)

## Environment Variables

Set in `.env` (never committed):

| Variable | Purpose |
|----------|---------|
| `ELECTROBUN_DEVELOPER_ID` | Developer ID certificate name |
| `ELECTROBUN_TEAMID` | Apple Team ID |
| `ELECTROBUN_APPLEID` | Apple ID for notarization |
| `ELECTROBUN_APPLEIDPASS` | App-specific password for notarization |

Check with: `make sign-check`
