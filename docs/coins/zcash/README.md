# Zcash — KeepKey Implementation Notes

## Chain Parameters

| Parameter | Value |
|-----------|-------|
| SLIP-44 | 133 (0x80000085) |
| Curve | secp256k1 (transparent), Pallas (Orchard shielded) |
| Address Format | Bech32 (transparent), Bech32m (unified) |
| Derivation Path | m/44'/133'/0'/0/0 (transparent) |
| CAIP-2 | bip122:00040fe8ec8471911baa1db1266ea15d |
| Network | mainnet (consensus branch ID varies by upgrade) |

## Architecture: Transparent vs Shielded

### Transparent (UTXO-based, firmware-supported)
- Works like Bitcoin with different network parameters
- Firmware handles `SignTx` with Zcash-specific serialization (ZIP-243/ZIP-244)
- KeepKey signs transparent inputs on-device
- Overwinter (v3) and Sapling (v4) transaction versions supported

### Shielded (Orchard, app-side)
- Uses PCZT (Partially Created Zcash Transaction) format
- Device signs the Orchard spend authorization key
- Proof generation happens on the host (too computationally expensive for STM32)
- Requires `lightwalletd` for note scanning and tree state

## Firmware Status

Transparent Zcash uses the existing UTXO signing path with Zcash-specific parameters:
- Coin defined in `coins.def` with Zcash network magic
- Branch ID handling for consensus upgrades
- Expiry height support

### Key Firmware Details
- Branch ID must match current network consensus rules
- Version group ID differs per transaction version
- Joinsplit support removed (deprecated in favor of Orchard)

## hdwallet Status

- `btcGetAddress` with `coin: 'Zcash'` — derives transparent address
- `btcSignTx` with `coin: 'Zcash'` — signs transparent UTXO transactions
- No native shielded support in hdwallet (handled by app-side PCZT flow)

## Transaction Format

### Transparent (v4/v5)
Uses ZIP-243 (v4) or ZIP-244 (v5) signature hash algorithm:
- Version + version group ID
- Transparent inputs/outputs (standard UTXO format)
- Lock time + expiry height
- Branch ID (consensus version identifier)

### Shielded (Orchard via PCZT)
1. App builds PCZT with transparent + shielded components
2. Device signs transparent inputs + Orchard spend authorization
3. App generates zero-knowledge proofs
4. App combines signatures + proofs into final transaction

## RPC Dependencies

- `lightwalletd` gRPC endpoint (for shielded: note scanning, tree state, broadcasting)
- Bitcoin-style RPC or block explorer (for transparent: UTXO lookup)
- Pioneer API provides transparent UTXO data

## Known Issues / Gotchas

- Branch ID changes with each network upgrade — must track current consensus
- Expiry height should be set to current height + 40 (default)
- Transparent-only transactions don't need `lightwalletd`
- Shielded proof generation takes 5-30 seconds on modern hardware
- Device can only sign spend authorization, not generate proofs
