# keepkey-cli

Bun/TypeScript CLI for direct KeepKey hardware wallet operations.

Uses `@keepkey/hdwallet-*` packages for dual-transport (HID + WebUSB) device communication. No REST API or desktop app dependency — works standalone.

## Setup

```bash
make cli-install   # from repo root
# or
cd projects/keepkey-cli && bun install
```

## Usage

```bash
# Via make (from repo root)
make cli ARGS=features
make cli ARGS="address bitcoin"

# Direct
cd projects/keepkey-cli
bun run src/index.ts features
bun run src/index.ts address ethereum --show
bun run src/index.ts load-seed --mnemonic "abandon abandon ... about"
```

## Commands

| Command | Description |
|---------|-------------|
| `features` | Show device info (firmware, PIN, label, etc.) |
| `initialize [12\|18\|24]` | Initialize with new seed |
| `wipe` | Factory reset |
| `load-seed --mnemonic "..."` | Load mnemonic onto device |
| `pin set\|change\|remove` | PIN operations |
| `label <name>` | Set device label |
| `passphrase on\|off` | Enable/disable passphrase |
| `firmware <path>` | Flash firmware (bootloader mode) |
| `address <coin>` | Get address for a coin |

### Supported Coins (address command)

bitcoin, ethereum, litecoin, dogecoin, cosmos, thorchain, osmosis, ripple, dash, bitcoincash

## Build Standalone Binary

```bash
make cli-build   # outputs dist/keepkey
```

## Architecture

```
src/
├── index.ts          # CLI entry point (command router)
├── device.ts         # Device connection (connect + get features)
├── commands/         # One file per command
│   ├── features.ts
│   ├── initialize.ts
│   ├── wipe.ts
│   ├── load-seed.ts
│   ├── pin.ts
│   ├── firmware.ts
│   ├── label.ts
│   ├── passphrase.ts
│   └── address.ts
└── util/
    └── transport.ts  # Dual-transport factory (WebUSB → HID fallback)
```

Transport pattern extracted from the vault's `engine-controller.ts` — tries WebUSB first (modern firmware, bulk endpoints), falls back to HID (bootloader, legacy, or OS-blocked USB).
