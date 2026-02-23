# KeepKey Vault

Desktop companion app for the [KeepKey](https://keepkey.com) hardware wallet. Built with [Electrobun](https://electrobun.dev) (Bun + system WebView), React 18, and Chakra UI.

## Features

- Device setup wizard, firmware updates, PIN/passphrase management
- Multi-chain: BTC, ETH, Cosmos, THORChain, Maya, Osmosis, BNB, XRP + EVM L2s
- Custom EVM chains and ERC-20 tokens
- Transaction signing (UTXO, EVM, Cosmos-family)
- Native QR scanner, WalletConnect v2
- Optional REST API on port 1646 (`kkapi://` protocol)
- Signed and notarized macOS builds

## Quick Start

```bash
git clone --recurse-submodules https://github.com/keepkey/keepkey-vault.git
cd keepkey-vault
make vault
```

See [projects/keepkey-vault/README.md](projects/keepkey-vault/README.md) for full documentation.

## Repository Structure

```
keepkey-vault/
  Makefile                    # All build targets (make help)
  modules/
    hdwallet/                 # Git submodule: keepkey/hdwallet
    proto-tx-builder/         # Git submodule: proto-tx-builder
  projects/
    keepkey-vault/            # Electrobun desktop app (source code)
      src/bun/                # Bun main process
      src/mainview/           # React frontend
      src/shared/             # Shared types
  .github/workflows/         # CI/CD
```

## Development

```bash
make dev-hmr      # Dev with hot reload (recommended)
make build        # Dev build
make build-signed # Signed + notarized macOS DMG
make help         # All targets
```

## License

MIT - see [projects/keepkey-vault/LICENSE](projects/keepkey-vault/LICENSE)
