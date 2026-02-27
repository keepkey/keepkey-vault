# KeepKey Vault v11 — Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Electrobun Desktop App                     │
│                                                               │
│  ┌─────────────────────┐     RPC      ┌────────────────────┐ │
│  │   Main Process (Bun) │◄──────────►│  WebView (React)    │ │
│  │                       │             │  Chakra UI 3.0      │ │
│  │  EngineController     │             │  Vite 6 + HMR       │ │
│  │  REST API Server      │             │  Tab state machine   │ │
│  │  SQLite Cache         │             └────────────────────┘ │
│  │  Auth Store           │                                     │
│  └───────────┬───────────┘                                     │
│              │                                                  │
│      HID / WebUSB                                              │
│              │                                                  │
│  ┌───────────▼───────────┐                                     │
│  │  @keepkey/hdwallet-*   │                                     │
│  │  Dual-transport layer  │                                     │
│  └───────────┬───────────┘                                     │
└──────────────┼──────────────────────────────────────────────┘
               │ USB
     ┌─────────▼─────────┐
     │   KeepKey Device    │
     │   STM32F205 + OLED  │
     │   Firmware 7.10.0   │
     └─────────────────────┘
```

## Components

### Main Process (`src/bun/`)

| File | Purpose |
|------|---------|
| `index.ts` | App entry: window creation, RPC bridge, event wiring |
| `engine-controller.ts` | Device lifecycle: connect, pair, PIN/passphrase, firmware update |
| `rest-api.ts` | HTTP REST API (port 1646, opt-in, kkapi:// compatible) |
| `auth.ts` | Bearer token auth, pairing requests, signing approval |
| `db.ts` | SQLite persistence (balances, pubkeys, settings, custom tokens/chains) |
| `pioneer.ts` | Pioneer API client (portfolio balances, tx building, market data) |
| `txbuilder/` | Transaction construction (UTXO, EVM, Cosmos) |
| `schemas.ts` | Zod schemas for REST API validation |
| `evm-rpc.ts` | Direct EVM chain RPC calls (balance, nonce, gas, broadcast) |
| `evm-addresses.ts` | EVM multi-address manager |
| `btc-accounts.ts` | BTC multi-account manager |
| `camera.ts` | QR code scanning via system camera |

### Frontend (`src/mainview/`)

| Directory/File | Purpose |
|----------------|---------|
| `App.tsx` | Tab-based state machine (dashboard, addresses, settings) |
| `components/` | TopNav, Dashboard, SendForm, OobSetupWizard, SplashScreen, etc. |
| `components/device/` | PinEntry, PassphraseEntry, RecoveryWordEntry |
| `hooks/` | useDeviceState, useBtcAccounts, useEvmAddresses, useFirmwareUpdate |
| `lib/rpc.ts` | Browser-side Electrobun RPC transport |

### CLI (`projects/keepkey-cli/`)

Standalone Bun/TypeScript CLI. Same `@keepkey/hdwallet-*` packages as vault, but no Electrobun/REST dependency. Direct device access for:
- Device info, initialization, wipe
- PIN/passphrase management
- Firmware flashing
- Address derivation

### Modules (`modules/`)

| Module | Type | Purpose |
|--------|------|---------|
| `hdwallet` | npm (yarn) | TypeScript wallet library — address derivation, message signing, transport layer |
| `proto-tx-builder` | npm (bun) | Transaction construction from Pioneer API responses |
| `keepkey-firmware` | C (CMake) | Device firmware — protobuf handlers, crypto, OLED UI |
| `device-protocol` | protobuf | `.proto` message definitions shared by firmware + hdwallet |

> **Note on hdwallet lodash/rxjs dependencies**: The lodash/rxjs imports have been removed from
> `hdwallet-core` and `hdwallet-keepkey` source code on the `master` branch (commit `179c5668`).
> `isObject` was inlined, `cloneDeep` replaced with `structuredClone`, `omit` replaced with a
> local helper, and `takeFirstOfManyEvents` (dead code) was removed. The build scripts
> (`collect-externals.ts`) still strip lodash/rxjs as a safety measure.

## Transport Layer

The dual-transport pattern is the same in both vault and CLI:

```
1. Try WebUSB (NodeWebUSBKeepKeyAdapter)
   ├── getDevice() — scan USB bus for KeepKey VID 0x2B24
   └── pairRawDevice() — claim device, establish communication
       └── Success → use WebUSB (bulk endpoints, modern firmware)

2. Fallback to HID (HIDKeepKeyAdapter)
   ├── getDevice() — scan HID devices
   └── pairRawDevice() — claim via HID API
       └── Success → use HID (works with bootloader, legacy, OS-blocked USB)
```

## Data Flow: Address Derivation

```
User clicks "Receive BTC"
  → React component calls RPC: btcGetAddress({ path, showDisplay: true })
  → Bun main process: engine.wallet.btcGetAddress(params)
  → hdwallet-keepkey: encodes GetAddress protobuf
  → Transport: sends to USB device
  → KeepKey device: derives key at path, shows address on OLED
  → User confirms on device
  → Transport: receives Address protobuf response
  → hdwallet-keepkey: decodes address string
  → RPC response → React displays address + QR code
```

## Data Flow: Transaction Signing

```
User fills send form (amount, recipient)
  → buildTx RPC: Pioneer API builds unsigned tx
  → signTx RPC: engine.wallet.btcSignTx(unsignedTx)
  → KeepKey device: shows tx details on OLED
  → User confirms on device (BUTTON_REQUEST events)
  → Device signs with private key (never leaves device)
  → Signed tx returned to app
  → broadcastTx RPC: Pioneer API broadcasts to network
```
