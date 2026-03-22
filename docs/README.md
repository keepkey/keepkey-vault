# KeepKey Vault Build Documentation

## Documents

| Document | Description |
|----------|-------------|
| [Electrobun Architecture](electrobun-architecture.md) | How Electrobun works: app lifecycle, `// @bun` header, directory structure, path resolution, Worker system, config reference |
| [Windows Build Pipeline](windows-build-pipeline.md) | Dev builds, production builds, code signing, Inno Setup installer, wrapper launcher, Windows-specific code fixes |
| [collect-externals Deep Dive](collect-externals-deep-dive.md) | How dependencies are collected, what gets pruned, file-linked packages, the relocatability problem, debugging tips |
| [Troubleshooting](troubleshooting-windows-build.md) | Known issues: relocatability, silent Worker death, ENOBUFS, google-protobuf globals, missing prebuilds, WebView2 locks |
| [Electrobun Reference](elctrobun.md) | Original Electrobun compatibility tables, platform support, code signing setup, architecture overview |

## Current Status

### What Works
- `bun run dev` from the source tree works perfectly
- All Windows source code fixes are correct and tested (PATH separators, `import.meta.dir`, cross-platform `du`, URL opening)

### What Doesn't Work
- The built app **cannot be relocated** (installed to a different directory) because the Bun Worker silently fails when external `require()` calls can't find packages that only exist in the dev `node_modules/`

### Root Cause
1. `index.js` has `// @bun` header (Bun pre-compiled bundle targeting Bun runtime)
2. External packages (declared in `electrobun.config.ts`) are resolved via `require()` at runtime
3. `collect-externals.ts` may not collect ALL transitive dependencies
4. In the build tree, Bun walks up to `projects/keepkey-vault/node_modules/` as fallback
5. When relocated, that fallback doesn't exist, and the Worker dies silently

### What Needs to Happen
1. Update Electrobun to latest (has dev CLI fix + other Windows fixes)
2. Audit `collect-externals.ts` to ensure ALL runtime dependencies are collected (including `@babel/runtime` and any other transitive deps)
3. Test relocatability by copying the build output to an isolated directory
4. Then the Inno Setup installer approach will work because the app will be self-contained
