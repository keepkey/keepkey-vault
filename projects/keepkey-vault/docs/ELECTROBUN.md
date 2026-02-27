# Electrobun Development Notes

## How Electrobun Works

Electrobun is a desktop app framework that uses **Bun** as the runtime and **system WebViews** (not bundled Chromium). This means:

- ~14MB app bundles (vs ~150MB+ for Electron)
- <50ms startup time
- Delta updates ~14KB
- Native WebView performance

## Two-Process Model

1. **Main process** (`src/bun/index.ts`): Runs in Bun runtime. Handles window management, file I/O, system APIs, and RPC bridge.
2. **View process** (`src/mainview/`): Runs in the system WebView. Standard web app (React, Vite).

Communication between processes uses Electrobun's typed RPC system (`electrobun/bun` + `electrobun/view`).

## Development Modes

### Standard Dev (`make dev`)
1. Vite compiles React app to `dist/`
2. `electrobun build` packages it into the native app bundle
3. `electrobun dev` launches the app loading from `views://mainview/index.html`

### HMR Dev (`make dev-hmr`)
1. Vite dev server starts on port 5173
2. Electrobun app detects the running Vite server
3. WebView loads from `http://localhost:5173` instead of bundled assets
4. Code changes reflect instantly without rebuilding

## Build Pipeline

```
src/mainview/ ──[vite build]──> dist/
                                  └──[collect-externals]──> build/_ext_modules/
                                                              └──[electrobun build]──> .app
```

### Production
```bash
make build-stable   # Production build with signing + notarization
make build-signed   # Full pipeline: build → prune → DMG → sign → notarize
```

## Config Files

- `electrobun.config.ts` - App identity, build copy rules, platform config
- `vite.config.ts` - Vite build settings (root, outDir, dev server port)
- `package.json` - Dependencies and script definitions

## Key Differences from Electron

| Feature | Electron | Electrobun |
|---------|----------|------------|
| Runtime | Node.js + Chromium | Bun + System WebView |
| IPC | `ipcMain`/`ipcRenderer` | Typed RPC (`electrobun/bun` + `electrobun/view`) |
| Bundle size | ~150MB+ | ~14MB |
| Startup | 500ms+ | <50ms |
| Updates | Full app download | Delta patches (~14KB) |
| Config | electron-builder/forge | `electrobun.config.ts` |
| Asset loading | `file://` protocol | `views://` protocol |

## Entitlements (macOS Production)

Production builds require `entitlements.plist` with JIT, unsigned executable memory, library validation bypass, and dyld env vars. These are needed because Bun uses JIT compilation. Without them, macOS Sequoia kills the process immediately.

The `prune-app-bundle.ts` script applies entitlements during the re-signing step.

## Troubleshooting

### ENOENT launcher error
The `electrobun build` step must run before `electrobun dev`. The dev script handles this:
```json
"dev": "vite build && bun scripts/collect-externals.ts && electrobun build && electrobun dev"
```

### HMR not working
Ensure Vite dev server is running on port 5173. Use `make dev-hmr` which starts both concurrently.

### WebView blank/white
Check browser console in the WebView. Common causes:
- Missing `dist/` output (run `vite build` first)
- Build copy paths wrong in `electrobun.config.ts`
- Most common cause: `vite.config.ts` missing `base: './'`. Absolute paths like `/assets/...` break under the `views://` protocol.
