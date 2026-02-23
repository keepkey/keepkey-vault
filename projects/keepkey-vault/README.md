# KeepKey Vault

Desktop companion app for the [KeepKey](https://keepkey.com) hardware wallet. Built with [Electrobun](https://electrobun.dev) (Bun + system WebView), React 18, and Chakra UI.

## Features

- **Device Management** - Setup wizard, firmware updates, PIN/passphrase, device settings
- **Multi-Chain Support** - Bitcoin, Ethereum, Cosmos, THORChain, Maya, Osmosis, Binance, XRP, and EVM L2s (Polygon, Arbitrum, Optimism, Avalanche, BSC, Base)
- **Custom EVM Chains & Tokens** - Add any EIP-155 chain or ERC-20 token
- **Transaction Signing** - UTXO, EVM, and Cosmos-family transaction building and signing
- **QR Scanner** - Native camera-based QR code scanning
- **REST API** - Optional localhost API on port 1646 for third-party integrations (`kkapi://` protocol)
- **WalletConnect v2** - Pair with dApps via WalletConnect
- **Auto-Updates** - Built-in update mechanism via GitHub Releases

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- [Yarn](https://yarnpkg.com) (for hdwallet module build)
- macOS, Linux, or Windows
- KeepKey hardware wallet

## Quick Start

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/keepkey/keepkey-vault.git
cd keepkey-vault

# Build modules + install deps + run
make vault
```

## Development

```bash
make dev          # Build and run
make dev-hmr      # Dev mode with hot module replacement (recommended)
make build        # Development build (unsigned)
make clean        # Remove all build artifacts
```

## Production Build

```bash
# Unsigned (CI)
make build-ci

# Signed + notarized macOS DMG (requires Apple Developer certs)
make build-signed
```

Signing requires these env vars (or a `.env` file):
- `ELECTROBUN_DEVELOPER_ID`
- `ELECTROBUN_TEAMID`
- `ELECTROBUN_APPLEID`
- `ELECTROBUN_APPLEIDPASS`

Run `make sign-check` to verify your signing environment.

## Architecture

```
src/
  bun/                # Main process (Bun runtime)
    engine-controller   Device lifecycle, USB events, firmware
    rest-api            Optional REST API (port 1646)
    txbuilder/          UTXO + EVM + Cosmos tx construction
    db                  SQLite for caching & custom chains/tokens
    pioneer             Pioneer API integration for balances
  mainview/           # Frontend (React, rendered in system WebView)
    components/         UI components (dashboard, settings, signing, etc.)
    hooks/              React hooks (device state, firmware, etc.)
    lib/rpc             RPC transport to Bun process
  shared/             # Shared between Bun and frontend
    rpc-schema          RPC method definitions
    chains              Chain definitions and constants
    types               TypeScript types
```

Communication between frontend and backend uses Electrobun's RPC system -- no HTTP required for device operations.

## Make Targets

| Target | Description |
|--------|-------------|
| `make vault` | Install + build + run (one command) |
| `make dev` | Build and run in dev mode |
| `make dev-hmr` | Dev with Vite HMR |
| `make build` | Development build |
| `make build-stable` | Production build (signed via Electrobun) |
| `make build-signed` | Full pipeline: build + DMG + sign + notarize |
| `make build-ci` | CI build (unsigned) |
| `make modules-build` | Build hdwallet + proto-tx-builder from source |
| `make audit` | Generate dependency manifest + SBOM |
| `make release` | Build + publish GitHub release |
| `make clean` | Remove all artifacts |

Run `make help` for the full list.

## REST API

Disabled by default. Enable with `KEEPKEY_REST_API=true`.

Runs on `http://localhost:1646` and is compatible with the `kkapi://` protocol used by the Pioneer SDK.

Key endpoints: `/api/health`, `/api/device/features`, `/api/btc/address`, `/api/eth/sign`, `/api/xpub`, and more. See `src/bun/rest-api.ts` for the full list.

## License

MIT
