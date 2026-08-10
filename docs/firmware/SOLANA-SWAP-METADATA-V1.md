# Solana transaction-bound swap metadata (`KKSOLSW1`)

`KKSOLSW1` is the canonical signed descriptor used to ClearSign cross-chain
swaps whose Solana instruction cannot be decoded completely on-device (for
example, a Relay instruction that references address-lookup-table accounts).

The descriptor does not replace Solana transaction parsing. Firmware still
parses the message structurally, rejects malformed messages, verifies that the
derived key is a required signer, and shows locally decoded priority fees.

## Trust and signature

- `payload` is the canonical byte sequence below.
- `signature` is a 64-byte compact secp256k1 ECDSA signature over
  `SHA256(payload)`.
- `signer_key_id` selects a ClearSign signer already trusted by the device.
- Firmware rejects partial metadata, invalid signatures, hash mismatches,
  program/discriminator mismatches, unsafe display text, and trailing bytes.
- A failed descriptor never downgrades to blind signing.

The quote/metadata service must resolve all lookup-table accounts and validate
the protocol instruction before signing the descriptor. The private attestation
key must not live in the Vault client.

## Canonical payload

All integers are unsigned big-endian. Text fields are one-byte length-prefixed,
printable ASCII, and may not contain `%`.

| Field | Encoding |
| --- | --- |
| Magic | 8 bytes: ASCII `KKSOLSW1` |
| Solana message hash | 32 bytes: SHA-256 of the exact serialized message signed by the device |
| Program ID | 32-byte Solana program public key |
| Instruction discriminator | First 8 instruction-data bytes |
| Quote expiry | `u64` Unix seconds |
| Source amount | `u64` base units |
| Minimum output | `u64` destination base units |
| Source decimals | `u8`, maximum 18 |
| Destination decimals | `u8`, maximum 18 |
| Protocol | `u8` length + 1–20 bytes |
| Source asset | `u8` length + 1–12 bytes |
| Destination chain | `u8` length + 1–16 bytes |
| Destination asset | `u8` length + 1–12 bytes |
| Destination address | `u8` length + 1–64 bytes |
| Order ID | `u8` length + 1–32 opaque bytes |

No bytes may follow the order ID.

## Device display

After verification, firmware displays:

1. ClearSign signer alias and fingerprint.
2. Source amount, asset, and protocol.
3. Minimum destination amount, asset, and chain.
4. The complete destination address.
5. Any locally decoded maximum priority fee.

The exact Solana message hash binds those claims to the transaction signature.
The program ID and discriminator additionally bind the descriptor to the
protocol instruction the metadata signer decoded.

## Opaque fallback

`SolanaSignTx.allow_opaque` authorizes blind signing for that protobuf request
only. It does not mutate persistent `AdvancedMode`. Firmware still shows a
dedicated one-time blind-sign warning and requires physical confirmation.

Hosts should set it only after a route-specific user acknowledgement. It is a
compatibility fallback for missing metadata, not a substitute for `KKSOLSW1`.
