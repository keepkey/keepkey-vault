# collect-externals.ts — Build Guide & Safety Rules

## Purpose

`scripts/collect-externals.ts` collects native Node.js addons and their transitive dependencies into `build/_ext_modules/` so Electrobun can bundle them into the `.app`. Bun's bundler cannot bundle native `.node` binaries or packages that rely on CJS `require()` patterns incompatible with ESM bundling.

## How It Works

1. **Dependency collection**: Walks `package.json` `dependencies` recursively from the EXTERNALS list, filtering out ~100 dev packages via DEV_BLOCKLIST (jest, babel, istanbul, ts-proto, etc.)
2. **Copy**: Copies each package from `node_modules/` to `build/_ext_modules/`
3. **@keepkey/* cleanup**: Strips `node_modules/` from `@keepkey/*` packages (lerna monorepo artifacts from `file:` resolution)
4. **Version-aware nested dedup**: Copies nested `node_modules/` where versions differ from top-level; skips same-version duplicates
5. **Prune**: Removes docs, tests, source maps, TypeScript declarations
6. **Native cleanup**: Removes non-macOS prebuilds, C/C++ source, build artifacts
7. **Directory strip**: Removes known-large unnecessary directories (protobufjs/cli, ethers/dist, etc.)
8. **Banned package removal**: Recursively removes `node-notifier`, `growly`, `is-wsl` (contain unsigned macOS binaries that break notarization)
9. **Code signing**: Signs all `.node`, `.dylib`, `.so` binaries AND extensionless Mach-O binaries (detected by reading first 4 bytes for magic numbers) with Apple Developer ID

## Critical Safety Rules

### NEVER blindly strip all nested node_modules

Nested `node_modules/` directories exist when a package requires a **different version** of a dependency than what's hoisted at top-level. Removing them causes runtime crashes that are extremely hard to diagnose (silent failures inside Electrobun Workers).

**Current behavior**: `stripDuplicateNestedNodeModules()` compares versions:
- Same version as top-level → safe to remove (duplicate)
- Different version from top-level → MUST keep

### ALWAYS include collect-externals in ALL build scripts

Every script that runs `electrobun build` or `electrobun dev` MUST run `bun scripts/collect-externals.ts` first. The Electrobun config copies `build/_ext_modules` → `node_modules` inside the app bundle.

```json
{
  "dev": "vite build && bun scripts/collect-externals.ts && electrobun build && electrobun dev",
  "build": "vite build && bun scripts/collect-externals.ts && electrobun build"
}
```

Missing this step causes: `failed to copy build/_ext_modules because it doesn't exist`

### ALWAYS test native module loading after changes

After modifying collect-externals, verify the app actually loads by running the bundled code directly:

```bash
cd build/dev-macos-arm64/keepkey-vault-dev.app/Contents/MacOS
timeout 10 ./bun ../Resources/app/bun/index.js 2>&1
```

This bypasses Electrobun's Worker isolation and shows actual crash errors that would otherwise be swallowed silently.

### NEVER add packages to STRIP_DIRS without checking dependents

Before adding a directory to `STRIP_DIRS`, verify no other package in the bundle imports from that path. Use:

```bash
grep -r "require.*PACKAGE_NAME" build/_ext_modules/ | grep -v node_modules/PACKAGE_NAME
```

## Debugging Build Failures

### Symptom: App window doesn't open, no error output

1. Kill stale processes: `pkill -f keepkey-vault-dev.app`
2. Run bundled code directly:
   ```bash
   cd build/dev-macos-arm64/keepkey-vault-dev.app/Contents/MacOS
   timeout 10 ./bun ../Resources/app/bun/index.js 2>&1
   ```
3. Look for `require()` errors — these indicate missing or version-incompatible deps

### Symptom: `failed to copy build/_ext_modules`

`collect-externals.ts` wasn't run before `electrobun build`. Check that the script is in the `dev`/`build` command chain.

### Symptom: Notarization fails on `.node` binaries

`collect-externals.ts` signs native binaries. Ensure `ELECTROBUN_DEVELOPER_ID` and `ELECTROBUN_TEAMID` env vars are set. Check that nested `node_modules/` don't contain unsigned binaries from devDependencies. Also check that `BANNED_PACKAGES` list in the script covers packages with unsigned Mach-O binaries (e.g., `node-notifier` ships `terminal-notifier.app`).

### Symptom: Bundle too large

Run `du -sh build/_ext_modules/` and compare to expected (~38MB). Check the collect-externals output for "Keeping nested" lines — version-differing deps may contain duplicated large packages. Consider adding overrides in `package.json` to align versions.

## Version Conflict Audit

To find all version-differing nested dependencies in the bundle:

```bash
bun scripts/collect-externals.ts 2>&1 | grep "Keeping nested"
```

If a kept package is large, consider:
1. Adding a `package.json` `overrides` entry to force the top-level version
2. Only if the parent package is compatible with the newer version
3. Test thoroughly — version overrides can cause subtle runtime breakage

## EXTERNALS List

Packages in the EXTERNALS list are excluded from Bun's bundler and loaded at runtime from the copied `node_modules/`. Add a package here when:

- It contains native `.node` addons (node-hid, usb, keccak, tiny-secp256k1)
- It uses CJS patterns incompatible with ESM bundling (google-protobuf `this || window`)
- It has complex require() chains that Bun's bundler can't resolve (ethers, hdwallet)
