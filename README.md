# KeepKey Vault v11

Desktop hardware wallet management built with **Electrobun** + **React 18** + **Chakra UI 3.0**, plus a standalone **Bun CLI** for direct device access.

## Architecture

```
Electrobun Desktop App
├── Main Process (Bun) ──── HID/WebUSB ──── KeepKey Device
│   ├── EngineController (device lifecycle)
│   ├── REST API Server (port 1646, opt-in)
│   └── SQLite Cache (balances, settings)
└── WebView (React + Chakra UI + Vite)

keepkey-cli (standalone)
└── Bun ──── HID/WebUSB ──── KeepKey Device
```

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- KeepKey hardware wallet connected via USB

## Quick Start

```bash
make install    # Build hdwallet + proto-tx-builder, install vault deps
make dev        # Build and launch desktop app
make dev-hmr    # Dev mode with Vite hot reload
```

## CLI

```bash
make cli ARGS=features              # Show device info
make cli ARGS="address bitcoin"     # Get Bitcoin address
make cli ARGS="address ethereum"    # Get Ethereum address
make cli ARGS="pin set"             # Set device PIN
make cli ARGS="label My-KeepKey"    # Set device label
```

See [projects/keepkey-cli/README.md](projects/keepkey-cli/README.md) for full CLI documentation.

## Make Targets

| Target | Description |
|--------|-------------|
| `make vault` | Install deps + build and run in dev mode |
| `make install` | Build modules + install vault dependencies |
| `make dev` | Build and run in dev mode |
| `make dev-hmr` | Dev mode with Vite HMR on port 5173 |
| `make build` | Development build (no signing) |
| `make build-signed` | Full pipeline: build + DMG + sign + notarize |
| `make cli ARGS=<cmd>` | Run keepkey-cli command |
| `make cli-build` | Compile standalone keepkey binary |
| `make firmware-build` | Build firmware via Docker |
| `make firmware-flash FW_PATH=<bin>` | Flash firmware binary |
| `make modules-build` | Build hdwallet + proto-tx-builder from source |
| `make clean` | Remove all build artifacts |
| `make help` | Show all available targets |

## Project Structure

```
keepkey-vault-v11/
├── Makefile                          # All operations
├── modules/                          # Git submodules
│   ├── hdwallet/                     # TypeScript wallet library (keepkey/hdwallet)
│   ├── proto-tx-builder/             # Transaction construction (keepkey/proto-tx-builder)
│   ├── keepkey-firmware/             # Device firmware, C (keepkey/keepkey-firmware)
│   └── device-protocol/             # Protobuf message definitions (keepkey/device-protocol)
├── projects/
│   ├── keepkey-vault/                # Electrobun desktop app
│   │   └── src/
│   │       ├── bun/                  # Main process (engine-controller, REST API, db)
│   │       ├── shared/               # Types shared between bun and mainview
│   │       └── mainview/             # React frontend
│   └── keepkey-cli/                  # Standalone CLI (Bun/TypeScript)
│       └── src/
│           ├── index.ts              # CLI entry point
│           ├── device.ts             # Device connection
│           └── commands/             # One file per command
└── docs/                             # Documentation
    ├── LLMs.txt                      # AI-readable project overview
    ├── ARCHITECTURE.md               # System architecture
    ├── COIN-ADDITION-GUIDE.md        # How to add a new coin
    ├── coins/                        # Per-coin implementation notes
    │   ├── solana/README.md
    │   ├── zcash/README.md
    │   ├── tron/README.md
    │   └── ton/README.md
    └── firmware/README.md            # Firmware build & flash guide
```

## Adding a New Coin

See [docs/COIN-ADDITION-GUIDE.md](docs/COIN-ADDITION-GUIDE.md) for the full 5-layer pipeline:
firmware → hdwallet → REST API → frontend → CLI.

## Supported Chains

Bitcoin, Ethereum, Cosmos, THORChain, Osmosis, Litecoin, Dogecoin, Bitcoin Cash, Dash, Ripple, Mayachain, Binance, and custom EVM chains.

## Tech Stack

- **Runtime**: [Electrobun](https://electrobun.dev) (Bun + native WebView, ~14MB bundle)
- **UI**: React 18 + Chakra UI 3.0 + Emotion
- **Build**: Vite 6 with HMR support
- **Routing**: React Router 7
- **Device**: @keepkey/hdwallet-* (HID + WebUSB dual-transport)
- **CLI**: Bun/TypeScript with direct device access

## Submodules

After cloning, initialize all submodules:

```bash
git submodule update --init
```

| Module | Purpose |
|--------|---------|
| [hdwallet](https://github.com/keepkey/hdwallet) | Address derivation, message signing, transport layer |
| [proto-tx-builder](https://github.com/keepkey/proto-tx-builder) | Transaction construction from Pioneer API |
| [keepkey-firmware](https://github.com/keepkey/keepkey-firmware) | Device firmware (C, STM32F205) |
| [device-protocol](https://github.com/keepkey/device-protocol) | Protobuf message definitions |
