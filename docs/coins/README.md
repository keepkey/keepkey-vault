# Coin Implementation Notes

Per-coin directories with implementation status, chain-specific notes, and gotchas.

## Directory Structure

```
coins/
├── solana/README.md   — Solana (Ed25519, Base58 addresses)
├── zcash/README.md    — Zcash (shielded + transparent, Orchard protocol)
├── tron/README.md     — TRON (secp256k1, Base58Check addresses)
└── ton/README.md      — TON (Ed25519, Base64 addresses)
```

## Adding a New Coin

See [COIN-ADDITION-GUIDE.md](../COIN-ADDITION-GUIDE.md) for the full 5-layer pipeline.

## Quick Checklist

- [ ] Firmware: protobuf messages defined
- [ ] Firmware: FSM handlers implemented
- [ ] Firmware: crypto functions implemented
- [ ] Firmware: built and flashed
- [ ] hdwallet: message types added
- [ ] hdwallet: getAddress + signTx implemented
- [ ] REST API: endpoints added
- [ ] Frontend: UI components added
- [ ] CLI: commands added
- [ ] Tests: E2E verification passing
