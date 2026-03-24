# Retro: Windows Release 1.2.6

## Root Cause

`modules/device-protocol` has `lib/` in `.gitignore`. The compiled protobuf
files (`messages_pb.js` etc.) only exist if built locally. On a fresh
checkout, `collect-externals.ts` copies an empty `lib/` into the bundle.
At runtime, `hdwallet-keepkey` does `require('device-protocol/lib/messages_pb')`
and bun crashes before any Electrobun code runs. No window, no logs, no error.

This was a "works on my machine" bug — macOS dev environments had the build
artifacts from prior work. Windows builds from fresh checkouts did not.

## Secondary Issues Found

1. **Vite content hashes**: `index-[hash].js` filenames cause WebView2 cache
   mismatch on over-install. Fixed with stable filenames.

2. **PowerShell 5 BOM**: `-Encoding UTF8` writes a BOM into `version.json`.
   Electrobun's `getVersionInfo()` fails, `Utils.paths.userData` throws,
   SQLite never initializes. Settings never persisted on Windows since v1.0.

3. **Installer `[InstallDelete]`**: Added in `040de00` to clean stale Vite
   assets. On upgrade, this could interact badly with WebView2 cache state.
   Removed — with stable filenames, stale assets are overwritten not accumulated.

4. **First-launch delay**: 56 seconds on Windows. Windows Defender scans
   178MB of files (bun.exe + 286 packages) on first run. Second launch: 1.1s.
   Fix: bundle JS into single file to reduce scan surface.

5. **Deferred init regression**: Moving DB init after window creation broke
   AuthStore — pairings loaded before DB was ready. Fixed with `reloadPairings()`.

6. **PowerShell em-dashes**: Build script had UTF-8 em-dashes that PowerShell 5
   can't parse. Fixed with ASCII double-hyphens.

## Fixes Applied

| File | Fix |
|------|-----|
| `collect-externals.ts` | Verify `messages_pb.js` exists, fail hard if missing |
| `build-windows-production.ps1` | Init device-protocol submodule, build lib/, fix em-dashes |
| `vite.config.ts` | Stable filenames (no content hashes) |
| `db.ts` | Strip BOM from version.json |
| `index.ts` | Deferred init, file logger, perf markers |
| `auth.ts` | `reloadPairings()` after DB init |
| `installer.iss` | Remove `[InstallDelete]`, add `SetupLogging=yes` |

## Key Diagnostic Pattern

When the app fails silently on Windows (no window, no logs):
1. Run `bun.exe` directly and capture stderr — shows the exact crash
2. Check `app.log` — if empty, failure is before WebView2 init
3. Check `vault-backend.log` — if missing, failure is before JS execution
4. Use the demo app (`projects/electrobun-test-app/`) to isolate machine vs app

## Windows Build Checklist

Before shipping any Windows installer:
- [ ] `modules/device-protocol/lib/messages_pb.js` exists
- [ ] `collect-externals` prints "Verified: device-protocol/lib/messages_pb.js present"
- [ ] `dist/assets/` has stable filenames (no hashes)
- [ ] Build script has no em-dashes (ASCII only in `.ps1` files)
- [ ] Fresh install on clean Windows works
- [ ] Over-install on existing install works
