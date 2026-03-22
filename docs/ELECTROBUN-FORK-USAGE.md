# Using the Electrobun Fork

## Overview

We maintain a fork of electrobun at `modules/electrobun` (submodule pointing to
`github.com/BitHighlander/electrobun`). This gives us control over the native
binaries (`libNativeWrapper.dll`, `main.js`, `launcher.exe`) that we ship on Windows.

## Why Not the npm Package

The `electrobun` npm package (from `blackboardsh/electrobun`) has issues:

1. `electrobun build` CLI downloads pre-built binaries from GitHub releases at build time
2. These downloads can fail (tar `C:` bug on Windows/MSYS) or produce inconsistent results
3. The downloaded binaries may not match the npm package version
4. We can't verify fixes (like PR #224 preload script fix) are in the downloaded DLL
5. No startup watchdog — `startEventLoop` hangs forever if WebView2 fails

## Repository Structure

```
keepkey-vault-public/
├── modules/
│   ├── electrobun/           ← submodule: BitHighlander/electrobun
│   │   ├── package/          ← the npm package source
│   │   │   ├── src/
│   │   │   │   ├── native/
│   │   │   │   │   ├── win/nativeWrapper.cpp   ← Windows native code
│   │   │   │   │   ├── mac/nativeWrapper.mm    ← macOS native code
│   │   │   │   │   └── linux/nativeWrapper.cpp ← Linux native code
│   │   │   │   ├── cli/      ← electrobun CLI (build, dev commands)
│   │   │   │   └── ...
│   │   │   ├── build.ts      ← build script
│   │   │   └── package.json
│   │   └── kitchen/          ← test/benchmark app
│   ├── hdwallet/
│   ├── device-protocol/
│   └── ...
└── projects/
    └── keepkey-vault/
        └── package.json      ← depends on electrobun (currently npm, switching to local)
```

## Building Electrobun from Source

### Prerequisites

- Windows: Visual Studio Build Tools (C++ workload), WebView2 SDK
- macOS: Xcode command line tools
- Linux: build-essential, libwebkit2gtk-4.1-dev, libappindicator3-dev

### Build Steps

```bash
cd modules/electrobun/package

# Install dependencies
bun install

# Build everything (native wrappers + CLI + TypeScript API)
bun build.ts

# Or run the kitchen sink test app (builds + launches)
bun dev
```

This produces:
- `dist-win-x64/libNativeWrapper.dll` — the Windows native wrapper (built locally)
- `dist-win-x64/main.js` — the launcher entry point
- `dist-win-x64/launcher.exe` — the process launcher
- `dist-win-x64/bun.exe` — bundled Bun runtime

### Using Local Build in KeepKey Vault

**Option A: Link the local package (recommended for development)**
```bash
cd projects/keepkey-vault
bun link ../../../modules/electrobun/package
```

**Option B: File dependency in package.json**
```json
{
  "dependencies": {
    "electrobun": "file:../../modules/electrobun/package"
  }
}
```

**Option C: Copy built artifacts directly**
```bash
# After building electrobun from source:
cp modules/electrobun/package/dist-win-x64/libNativeWrapper.dll \
   projects/keepkey-vault/_build/dev-win-x64/keepkey-vault-dev/bin/

cp modules/electrobun/package/dist-win-x64/main.js \
   projects/keepkey-vault/_build/dev-win-x64/keepkey-vault-dev/Resources/
```

## Benchmark App

The `kitchen/` directory contains electrobun's test app. Use it to verify
Windows startup independently of KeepKey Vault:

```bash
cd modules/electrobun/package
bun dev  # builds and launches the kitchen sink app
```

**Target benchmarks:**
| Metric | Target | Measured |
|--------|--------|----------|
| Window visible (cold) | < 5s | TBD |
| Window visible (warm) | < 2s | TBD |
| Content loaded | < 3s | TBD |
| RPC bridge ready | < 4s | TBD |

## Fixes in Our Fork (vs upstream)

| Fix | Status | Description |
|-----|--------|-------------|
| PR #224 preload fix | ✅ Included | views:// URLs resolved on Windows |
| tar extraction bug | TODO | `--force-local` for Windows paths |
| Startup watchdog | TODO | Exit after 30s if no window created |
| Structured logging | TODO | Timestamp each WebView2 init step |
| Zig 0.15.2 compat | TODO | `.ptr` cast for DrawTextW |

## Keeping the Fork Updated

```bash
cd modules/electrobun
git remote add upstream https://github.com/blackboardsh/electrobun.git
git fetch upstream
git merge upstream/main
# Resolve conflicts, test, push
```

## CI Integration

TODO: GitHub Actions workflow to:
1. Build electrobun from source on Windows runner
2. Run benchmark app, verify window opens
3. Build keepkey-vault using local electrobun
4. Package and sign installer
5. Run smoke test (install + launch + verify window)
