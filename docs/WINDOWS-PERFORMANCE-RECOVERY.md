# Windows Performance: Pre-Bundle Recovery

The Windows installer's first-launch performance depends on having as few files as possible inside `Resources/app/node_modules/`. Each file Windows Defender encounters on the first launch is scanned synchronously, and `bun.exe` triggers Defender for every file it `require()`s. The historical baseline was 13,400 files → **56 seconds** of Defender scan on first launch.

Commit `cc9181e` (2026-03-22, "perf: pre-bundle backend — 13,400 files to 393, first launch 56s to 2.1s") solved this by inlining nearly all pure-JS dependencies into a single `Resources/app/bun/index.js`. That commit cut the install to 393 files and first-launch to 2.1 seconds.

**That optimization has since eroded back to ~14,800 files.** This document explains why, what's recoverable, and the constraints for recovering it safely.

---

## Current state

Run a check before any recovery work:

```powershell
$build = "projects\keepkey-vault\_build\dev-win-x64\keepkey-vault-dev"
(Get-ChildItem -Recurse -File $build | Measure-Object).Count
(Get-ChildItem -Recurse -File "$build\Resources\app\node_modules" | Measure-Object).Count
Get-ChildItem "$build\Resources\app\bun" | Select-Object Name, Length
```

Expected (post-recovery): total ~400-600 files, `node_modules` < 200 files, `Resources/app/bun/index.js` ≈ 6-16 MB.
Current (regressed): total ~14,800, `node_modules` ~14,800, `index.js` ≈ 6.5 MB.

`bundle-backend.ts` is still running — `index.js` is being produced. What's regressed is `collect-externals.ts`'s externalization list.

---

## Why it regressed

After `cc9181e` landed, six follow-up commits had to re-externalize packages that Bun's bundler couldn't safely inline. Each re-externalization brought the package back into `node_modules/` along with its transitive deps:

| Commit | Package(s) re-externalized | Root cause |
|---|---|---|
| `9d27f25` | `google-protobuf` | Bundler breaks `jspb.Message` methods (uses `this \|\| window` global pattern) |
| `0905f58` | `@keepkey/proto-tx-builder` | Depends on osmosis-frontend submodule for Cosmos proto codegen |
| `ac3b25d` | `swagger-client` (+ `@swagger-api/apidom-*`) | `export * from 'node:buffer'` resolves to `undefined` when bundled → Linux crash |
| `0d9a5f7` | `@walletconnect/*` | ESM/CJS dual-package resolution: auth-client imports `isBrowser`/`TYPE_1` from utils that aren't in CJS exports |
| `18552a6` | (no new entries — recursion fix) | `addNestedDeps` started walking nested `node_modules`, transitively pulling more deps |
| `6776099` | (more WC missing deps) | WalletConnect transitive deps were missing on first install |

Each was a correct fix at the time. The combined effect is what we see today.

### Where the file count is concentrated

```
@swagger-api       1,591 files   ← biggest single contributor (apidom 3.0/3.1/3.2 + JSON Schema drafts)
@walletconnect       865 files   ← 21 subpackages, ESM/CJS hell
@babel               800 files   ← transitive
@cosmjs              386 files   ← transitive of proto-tx-builder
@noble               145 files
@ethersproject       130 files
(180 other top-level packages)  ~10,000 files
```

---

## What's recoverable now

Bun's bundler has improved significantly since these fixes landed. Each re-externalization is worth re-evaluating, but **not all at once and not during a release**.

### Highest impact, lowest risk

1. **`google-protobuf`** — small (~50 files), single root cause (global `this`). Worth a targeted retry: wrap with a polyfill at bundle time, or try Bun's updated CJS handling. ~50 file reduction.

2. **`@noble/*` and `@ethersproject/*`** — 275 files combined, all pure ESM, no native deps. These almost certainly bundle clean now but they may already be inlined; verify before counting them.

### Medium impact, medium risk

3. **`@walletconnect/*`** — 865 files. This is the highest-value chunk. The ESM/CJS issue was a Bun bundler limitation; check whether modern Bun resolves `auth-client → utils` correctly. Test with a real WalletConnect dApp pairing flow before relying on a bundled build.

4. **`@cosmjs/*` (via `proto-tx-builder`)** — 386 files. `proto-tx-builder` itself can't be bundled (submodule build), but its transitive `@cosmjs/*` deps can be examined.

### Largest gain, highest risk

5. **`@swagger-api/*` + `swagger-client`** — 1,591 files, 4x more than the next-largest package. Two paths:
   - Try bundling `swagger-client` again after fixing the `node:buffer` issue at bundle time (Bun plugin that rewrites `export * from 'node:buffer'`).
   - **Or eliminate the dependency entirely** — `windows-performance-strategy.md` proposed replacing `@pioneer-platform/pioneer-client` (the sole consumer of `swagger-client`) with a thin hand-written fetch wrapper for the 5-6 Pioneer endpoints actually used. ~3,500 files / 16 MB saved. This is the cleanest long-term fix but requires real engineering work and Pioneer API stability assumptions.

---

## Verification gates for any recovery attempt

Each re-bundling must pass:

1. **Cross-platform check** — Linux is the canary for `node:buffer`-style bundler bugs. macOS first-launch and Linux first-launch must both succeed.
2. **Cold install on Windows 10 + 11** — first-launch shouldn't show the `[Engine] Loaded bundled manifest` hang that `cc9181e` originally fixed.
3. **Full smoke** — pair a device, run a swap quote, complete a WalletConnect handshake, sign an EVM tx, sign a Cosmos tx, fetch a Bitcoin balance. The original regression bugs all surfaced as either silent crashes or wrong-data bugs, not as build-time errors.
4. **File count diff in CI** — every PR that touches `collect-externals.ts` or `bundle-backend.ts` should print a before/after file count. Regressions over 500 files are flagged for review.

---

## What's recoverable on the build machine, separately

Independent of bundle work, the **build machine's** Defender configuration significantly affects build time. Each file in the staging copy (`robocopy → C:\tmp\kk`) is real-time scanned. Adding the right exclusions cuts staging from minutes to seconds:

```powershell
# Run in an Administrator PowerShell
Add-MpPreference -ExclusionPath "<absolute path to your keepkey-vault checkout>"
Add-MpPreference -ExclusionPath "C:\tmp\kk"
Add-MpPreference -ExclusionProcess "signtool.exe","robocopy.exe","bun.exe","node.exe","cargo.exe","ISCC.exe"
```

These exclusions are **build-machine local** — they have no effect on end-user installs. End users get full Defender protection on the installed app.

---

## Suggested follow-up work

1. **Open an issue** titled "Recover pre-bundle file count regression (14,800 → target ~500)" referencing this doc and `cc9181e`.
2. **Tackle in order**: google-protobuf → @noble/@ethersproject (verify status) → @walletconnect → swagger-client (or pioneer-client replacement).
3. **Land each retry as its own PR** with a Windows install + smoke test plan. Do not bundle multiple re-bundles into one change — when something breaks, we need a clean bisect target.
4. **Add a file-count check to CI** — fail the Windows build if `Resources/app/node_modules/` exceeds a configured threshold (start at 15,000, ratchet down as recoveries land).

---

## Files

- `projects/keepkey-vault/scripts/bundle-backend.ts` — the working pre-bundler
- `projects/keepkey-vault/scripts/collect-externals.ts` — where the re-externalization list lives (`FORCE_EXTERNAL` set)
- `projects/keepkey-vault/scripts/patch-bundle.ts` — post-build patches for known bundler bugs (e.g. `node_buffer`)
- `projects/keepkey-vault/docs/windows-performance-strategy.md` — original strategy doc (medium-term + long-term plans)
