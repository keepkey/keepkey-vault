# TRON — KeepKey Implementation Notes

## Chain Parameters

| Parameter | Value |
|-----------|-------|
| SLIP-44 | 195 (0x800000C3) |
| Curve | secp256k1 |
| Address Format | Base58Check (prefix T, 21-byte hash) |
| Derivation Path | m/44'/195'/0'/0/0 |
| CAIP-2 | tron:mainnet |

## Address Derivation

TRON addresses use the same curve as Ethereum (secp256k1) but a different address format:
1. Derive secp256k1 public key at BIP-44 path
2. Keccak-256 hash of the uncompressed public key (minus 04 prefix)
3. Take last 20 bytes
4. Prepend `0x41` (mainnet prefix)
5. Base58Check encode (double SHA-256 checksum)

## Firmware Status

TRON support in firmware 7.7.0+:
- `TronGetAddress` — derives address using secp256k1 + TRON address encoding
- `TronSignTx` — signs protobuf-encoded TRON transaction

### Firmware Files
- `modules/device-protocol/messages-tron.proto`
- `modules/keepkey-firmware/lib/firmware/tron.c`

## hdwallet Status

Implemented in `@keepkey/hdwallet-keepkey`:
- `tronGetAddress({ addressNList, showDisplay })`
- `tronSignTx({ addressNList, rawTx })` — raw protobuf transaction bytes

## Transaction Format

TRON uses Google Protocol Buffers for transaction encoding:
```
Transaction {
  raw_data {
    contract [{
      type: TransferContract | TriggerSmartContract | ...
      parameter: Any (contract-specific protobuf)
    }]
    ref_block_bytes
    ref_block_hash
    expiration
    timestamp
  }
  signature []
}
```

Common contract types:
- `TransferContract` — TRX transfer
- `TriggerSmartContract` — TRC-20 token transfer
- `FreezeBalanceV2Contract` — staking
- `VoteWitnessContract` — governance voting

## RPC Dependencies

- TRON Full Node API (e.g., `https://api.trongrid.io`)
- Needed for: block reference, fee estimation, broadcasting, TRC-20 token info

## Known Issues / Gotchas

- Transaction encoding is protobuf (not RLP like Ethereum)
- Device signs the raw protobuf bytes of `Transaction.raw_data`
- TRC-20 token transfers use `TriggerSmartContract` with ABI-encoded data
- Bandwidth/energy model instead of gas — free daily bandwidth for TRX transfers
- Block reference bytes must be from a recent block (within ~27 hours)
