# KeepKey Vault v11

Desktop hardware wallet application built with **Electrobun** (Bun main process + system WebView) + **React 18** + **Chakra UI 3.0**.

## Architecture

```
Electrobun Desktop App
├── Main Process (Bun) ──── USB (HID + WebUSB) ──── KeepKey Device
│   ├── Engine Controller (device lifecycle, USB events)
│   ├── SQLite persistence (bun:sqlite)
│   ├── Pioneer API integration (balance/portfolio)
│   └── REST API on port 1646 (opt-in, KEEPKEY_REST_API=true)
└── WebView (React 18 + Chakra UI 3.0 + Vite)
    └── Tab-based state machine (dashboard | addresses | settings)
```

- The vault talks directly to the KeepKey device via USB -- no external desktop app dependency.
- All device operations go through Electrobun RPC (no REST required for normal use).
- The REST API on port 1646 is opt-in (`KEEPKEY_REST_API=true`), compatible with the `kkapi://` protocol.
- No React Router -- the UI uses a simple tab-based state machine.
- Theme: black/gold (#000/#111/#FFD700) matching KeepKey branding.

## Prerequisites

- [Bun](https://bun.sh) >= 1.3.5
- [Yarn](https://yarnpkg.com) (for hdwallet monorepo build)
- KeepKey hardware wallet connected via USB
- For signing/notarization: Apple Developer ID certificate + Xcode CLI tools

## Quick Start

```bash
make vault      # Build modules + install deps + run dev mode
make dev        # Build and run in dev mode
make dev-hmr    # Dev mode with Vite HMR
```

## Make Targets

| Target | Description |
|--------|-------------|
| `make vault` | Build modules + install deps + run dev mode |
| `make dev` | Build and run in dev mode |
| `make dev-hmr` | Dev mode with Vite HMR |
| `make build` | Development build (no signing) |
| `make build-signed` | Full pipeline: build, prune, DMG, sign, notarize |
| `make prune-bundle` | Prune app bundle (version-aware dedup + re-sign) |
| `make dmg` | Create DMG from existing build |
| `make upload-dmg` | Upload signed DMG to CI draft release |
| `make release` | Build, sign, and create new GitHub release |
| `make modules-build` | Build hdwallet + proto-tx-builder from source |
| `make audit` | Generate dependency manifest + SBOM |
| `make clean` | Remove all build artifacts |

## Project Structure

```
keepkey-vault-v11/
├── Makefile
├── modules/
│   ├── hdwallet/                   # Git submodule: keepkey/hdwallet (yarn+lerna)
│   ├── proto-tx-builder/           # Git submodule: @keepkey/proto-tx-builder
│   ├── keepkey-firmware/           # Git submodule: device firmware (C, CMake)
│   └── device-protocol/           # Git submodule: protobuf definitions
├── docs/
│   ├── ARCHITECTURE.md
│   ├── COIN-ADDITION-GUIDE.md
│   ├── coins/
│   └── firmware/README.md
├── firmware/                       # Firmware manifest + binaries
└── projects/
    └── keepkey-vault/              # Electrobun app
        ├── electrobun.config.ts
        ├── vite.config.ts
        ├── entitlements.plist
        ├── scripts/                # Build scripts (collect-externals, prune, etc.)
        ├── docs/                   # BUILD.md, API.md, ELECTROBUN.md
        └── src/
            ├── bun/                # Main process
            │   ├── index.ts        # Electrobun RPC + engine controller + REST
            │   ├── engine-controller.ts  # USB event-driven device lifecycle
            │   ├── rest-api.ts     # Bun.serve() REST API (opt-in)
            │   ├── evm-rpc.ts      # EVM chain RPC calls
            │   └── ...             # DB, Pioneer, TX builder modules
            ├── shared/
            │   ├── rpc-schema.ts   # Electrobun RPC type definitions
            │   ├── types.ts        # DeviceStateInfo, FirmwareProgress, etc.
            │   └── chains.ts       # Chain definitions
            └── mainview/           # React frontend
                ├── main.tsx        # React entry + ChakraProvider
                ├── App.tsx         # Tab-based state machine (no router)
                ├── components/
                │   ├── Dashboard.tsx
                │   ├── Addresses.tsx
                │   ├── TopNav.tsx
                │   ├── SplashScreen.tsx
                │   ├── OobSetupWizard.tsx
                │   ├── DeviceSettings.tsx
                │   └── device/     # PinEntry, PassphraseEntry, RecoveryWordEntry
                ├── hooks/          # useDeviceState, useFirmwareUpdate, etc.
                └── lib/            # rpc.ts (browser-side RPC transport)
```

## Supported Chains

- **Bitcoin**: Multi-account, SegWit (p2wpkh, p2sh-p2wpkh, p2pkh)
- **Ethereum + 6 EVM L2s**: Polygon, Arbitrum, Optimism, Avalanche, BSC, Base
- **Cosmos ecosystem**: Cosmos, THORChain, Osmosis, Mayachain
- **Other**: Ripple (XRP), Binance (BNB), Solana
- **Custom EVM chains**: User-defined via Add Chain dialog

## Tech Stack

- **Runtime**: [Electrobun](https://electrobun.dev) (Bun + system WebView)
- **UI**: React 18 + Chakra UI 3.0
- **Build**: Vite 6
- **Device communication**: @keepkey/hdwallet-* (HID + WebUSB dual transport with automatic fallback)
- **Persistence**: SQLite (bun:sqlite)
- **Signing**: Apple codesign + notarize + staple

## Documentation

- [Build and Signing Guide](projects/keepkey-vault/docs/BUILD.md)
- [REST API Reference](projects/keepkey-vault/docs/API.md)
- [Electrobun Integration](projects/keepkey-vault/docs/ELECTROBUN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Coin Addition Guide](docs/COIN-ADDITION-GUIDE.md)

## Submodules

After cloning, initialize the git submodules:

```bash
git submodule update --init --recursive
```

The `modules/hdwallet/` submodule must be on the `master` branch (which has lodash/rxjs removed from source). Build with:

```bash
make modules-build
```

This builds proto-tx-builder (bun + tsc) then hdwallet (yarn install + yarn build).
