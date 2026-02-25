# Solana — KeepKey Implementation Notes

## Chain Parameters

| Parameter | Value |
|-----------|-------|
| SLIP-44 | 501 (0x800001F5) |
| Curve | Ed25519 |
| Address Format | Base58 (32-byte public key) |
| Derivation Path | m/44'/501'/0' |
| CAIP-2 | solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp |

## Firmware Status

Solana support exists in KeepKey firmware 7.7.0+:
- `SolanaGetAddress` — Ed25519 key derivation, Base58 address
- `SolanaSignTx` — signs raw serialized transaction bytes
- Message types: 900-903

### Firmware Files
- `modules/device-protocol/messages-solana.proto`
- `modules/keepkey-firmware/lib/firmware/solana.c`
- `modules/keepkey-firmware/include/keepkey/firmware/solana.h`

## hdwallet Status

Implemented in `@keepkey/hdwallet-keepkey`:
- `solanaGetAddress({ addressNList, showDisplay })`
- `solanaSignTx({ addressNList, rawTx })`

## Transaction Format

Solana transactions use a compact binary format:
1. Signatures section (64 bytes per signer)
2. Message header (3 bytes: numSigners, numReadonlySigners, numReadonlyUnsigned)
3. Account addresses (32 bytes each)
4. Recent blockhash (32 bytes)
5. Instructions (programId index, account indices, data)

The device signs the **message** portion (everything after signatures). The app prepends the signature to create the complete signed transaction.

## RPC Dependencies

- Solana RPC endpoint (e.g., `https://api.mainnet-beta.solana.com`)
- Needed for: recent blockhash, fee estimation, token accounts, broadcasting

## Known Issues / Gotchas

- Ed25519 derivation uses a hardened-only path (no unhardened children)
- SPL token transfers require associated token account creation
- Versioned transactions (v0) use address lookup tables — additional complexity
- Transaction size limit: 1232 bytes
