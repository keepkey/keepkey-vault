# KeepKey Vault v11

Desktop hardware wallet management UI built with **Electrobun** + **React 18** + **Chakra UI 3.0**.

## Architecture

```
Electrobun Desktop App
├── Main Process (Bun) ──── HTTP REST ──── keepkey-desktop (port 1646) ──── KeepKey Device
└── WebView (React + Chakra UI + Vite)
```

- **Main process** (`src/bun/index.ts`): Bun runtime, window management, RPC bridge
- **WebView** (`src/mainview/`): React 18 + Chakra UI 3.0, client-side routing
- **API layer**: Direct REST client to keepkey-desktop on port 1646 (no Pioneer SDK)
- **Theme**: Black/gold (#000/#111/#FFD700) matching KeepKey branding

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [keepkey-desktop](https://github.com/keepkey/keepkey-desktop) running on port 1646
- KeepKey hardware wallet connected via USB

## Quick Start

```bash
make install    # Install dependencies
make dev        # Build and launch app
make dev-hmr    # Dev mode with Vite hot reload
```

## Make Targets

| Target | Description |
|--------|-------------|
| `make install` | Install dependencies |
| `make dev` | Build and run in dev mode |
| `make dev-hmr` | Dev mode with Vite HMR on port 5173 |
| `make build` | Production build |
| `make build-prod` | Production build (prod channel) |
| `make clean` | Remove build artifacts and node_modules |

## Project Structure

```
keepkey-vault-v11/
├── Makefile                          # Top-level make targets
├── hdwallet/                         # Git submodule: keepkey/hdwallet
└── projects/
    └── keepkey-vault/                # Electrobun app
        ├── electrobun.config.ts      # App identity & build config
        ├── vite.config.ts            # Vite build config
        ├── package.json
        └── src/
            ├── bun/index.ts          # Main process (window, RPC)
            ├── shared/types.ts       # RPC type definitions
            └── mainview/
                ├── main.tsx          # React entry + Chakra Provider
                ├── App.tsx           # Router + layout shell
                ├── theme.ts          # Chakra 3.0 black/gold theme
                ├── components/
                │   ├── layout/       # Header, Sidebar, StatusBar
                │   ├── dashboard/    # Dashboard overview
                │   ├── device/       # DeviceStatus, PinEntry, Settings
                │   ├── addresses/    # Multi-chain address derivation
                │   └── signing/      # Transaction signing
                ├── hooks/            # useKeepKey, useApi
                ├── services/         # keepkey-api.ts (REST client)
                └── types/            # Frontend type definitions
```

## keepkey-desktop API

The app communicates with keepkey-desktop's REST API on port 1646:

- **Auth**: `POST /auth/pair` (get Bearer token)
- **Addresses**: `/addresses/eth`, `/addresses/utxo`, `/addresses/cosmos`, etc.
- **Signing**: `/eth/sign-transaction`, `/utxo/sign-transaction`, `/cosmos/sign-amino`, etc.
- **System**: `/system/info/get-features`, `/system/apply-settings`, `/system/wipe-device`, etc.

See [docs/API.md](docs/API.md) for the full endpoint reference.

## Supported Chains

Bitcoin, Ethereum, Cosmos, THORChain, Osmosis, Litecoin, Dogecoin, Bitcoin Cash, Dash, Ripple, Mayachain, Binance

## Tech Stack

- **Runtime**: [Electrobun](https://electrobun.dev) (Bun + system WebView, ~14MB bundle)
- **UI**: React 18 + Chakra UI 3.0 + Emotion
- **Build**: Vite 6 with HMR support
- **Routing**: React Router 7
- **API**: Direct fetch to keepkey-desktop REST API

## hdwallet Submodule

The `hdwallet/` directory is a git submodule pointing to [keepkey/hdwallet](https://github.com/keepkey/hdwallet). To initialize after cloning:

```bash
git submodule update --init --recursive
```
