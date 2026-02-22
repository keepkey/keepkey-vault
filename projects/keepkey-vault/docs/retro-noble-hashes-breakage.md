# Retrospective: @noble/hashes Version Conflict Crash

**Date**: 2026-02-21
**Severity**: P0 — App fails to launch (silent crash inside Electrobun Worker)
**Branch**: hotfix-noble-hashes
**Time to diagnose**: ~2 hours (misleading symptom — appeared as "hang" not "crash")

## Incident Summary

`make dev-hmr` produced no app window and no error output. The Electrobun launcher started successfully, but the Bun Worker process silently crashed before executing any app code. No logs, no error dialog — the process stayed alive but produced zero output.

## Root Cause

**Version conflict between `@noble/hashes@1.8.0` (top-level) and `@noble/hashes@1.4.0` (required by `ethereum-cryptography@2.2.1`).**

### The Dependency Chain

```
@keepkey/hdwallet-keepkey-nodehid
  → @keepkey/hdwallet-keepkey
    → ethereumjs-util
      → ethereum-cryptography@2.2.1
        → @noble/hashes@1.4.0  (nested node_modules — NEEDED)
```

### What `ethereum-cryptography` Does

```javascript
// ethereum-cryptography/utils.js
const _assert_1 = __importDefault(require("@noble/hashes/_assert"));
const assertBool = _assert_1.default.bool;  // ← CRASHES HERE
```

### API Difference

| Feature | @noble/hashes@1.4.0 | @noble/hashes@1.8.0 |
|---------|---------------------|---------------------|
| `_assert.bool` | Exists | REMOVED |
| `_assert.bytes` | Exists | Renamed to `abytes` |
| `_assert.number` | Exists | Renamed to `anumber` |
| `_assert.exists` | Exists | Renamed to `aexists` |

### Why It Was Stripped

`collect-externals.ts` had a function `stripAllNestedNodeModules()` that **blindly removed all nested `node_modules/` directories** inside collected packages. The rationale was correct for most cases:

- Bun hoists deps, so nested copies are usually duplicates
- Nested `node_modules` from `file:` deps drag in devDependencies (jest, node-notifier) that break macOS notarization
- Duplicate hdwallet-core copies added ~64MB of bloat

But it failed for **version-differing nested deps** — packages where the parent requires a different version than what's hoisted at top-level.

## Fix

Replaced `stripAllNestedNodeModules()` with `stripDuplicateNestedNodeModules()`:

- Compares `package.json` version between nested and top-level packages
- **Same version**: Remove (it's a duplicate)
- **Different version**: Keep (the parent needs this specific version)
- Handles scoped packages (`@noble/hashes`, `@types/node`, etc.)
- Logs kept packages for build visibility

### Packages Preserved After Fix

| Package | Nested Version | Top-Level Version |
|---------|---------------|-------------------|
| `@noble/hashes` | 1.4.0 | 1.8.0 |
| `@noble/curves` | 1.4.2 | 1.8.1 |
| `hash-base` | 3.1.2 | 3.0.5 |
| `bs58check` | 2.1.2 | 3.0.1 |
| `crypto-js` | 3.3.0 | 4.2.0 |
| `bn.js` | 4.12.3 | 5.2.3 |

## Secondary Fix

The `dev` script in `package.json` was missing `bun scripts/collect-externals.ts`, so native modules were never copied to `build/_ext_modules` during dev builds. The `build` script had it, but `dev` did not — likely a copy-paste omission.

## Why It Was Hard to Diagnose

1. **Silent failure**: Electrobun runs app code in a Worker. The Worker crashed, but the launcher process stayed alive. No error was surfaced to the terminal.
2. **Misleading symptom**: "No window opens" looked like a hang, not a crash. Process showed as running (`ps aux` showed it alive at ~80MB).
3. **No error logs**: The crash happens during CJS `require()` at module load time — before any `console.log` in our app code executes.
4. **Electrobun stderr not captured**: The `make dev-hmr` pipeline (concurrently → electrobun dev → launcher → Worker) doesn't surface Worker stderr to the terminal.

### How We Found It

Ran the bundled code directly:
```bash
cd build/dev-macos-arm64/keepkey-vault-dev.app/Contents/MacOS
timeout 10 ./bun ../Resources/app/bun/index.js 2>&1
```

This bypassed Electrobun's launcher/Worker isolation and showed the actual TypeError stack trace.

## Timeline

1. `make dev-hmr` — no window, no error
2. Checked stale processes — found multiple orphaned Electrobun instances
3. Killed stale processes, retried — same result
4. Analyzed bundled `index.js` — found circular `__esm` init (red herring — stock Electrobun)
5. Ran bundled code directly with `./bun` — got the TypeError
6. Traced to `@noble/hashes` version mismatch
7. Found `stripAllNestedNodeModules()` as the culprit
8. Implemented version-aware stripping — app launches
