# TON — KeepKey Implementation Notes

## Chain Parameters

| Parameter | Value |
|-----------|-------|
| SLIP-44 | 607 (0x8000025F) |
| Curve | Ed25519 |
| Address Format | Base64url (raw: 36 bytes = 1 byte flags + 1 byte workchain + 32 byte hash + 2 byte CRC16) |
| Derivation Path | m/44'/607'/0' |
| CAIP-2 | ton:mainnet |

## Address Derivation

TON addresses are derived from a smart contract's initial state hash, not directly from the public key:
1. Derive Ed25519 keypair at BIP-44 path
2. Compute initial code + data cells for the wallet contract (v4r2 recommended)
3. Hash the StateInit to get the account address
4. Encode as Base64url with workchain ID (0 = basechain) and CRC16 checksum

**Simplified approach (used in v10):** Some implementations use a simpler address derivation that skips the full StateInit computation, mapping the public key more directly. This produces valid but potentially non-standard addresses.

## Firmware Status

TON support in firmware 7.10.0+:
- `TonGetAddress` — Ed25519 key derivation + TON address encoding
- `TonSignMessage` — signs arbitrary message bytes

### Firmware Files
- `modules/device-protocol/messages-ton.proto`
- `modules/keepkey-firmware/lib/firmware/ton.c`

## hdwallet Status

Implemented in `@keepkey/hdwallet-keepkey`:
- `tonGetAddress({ addressNList, showDisplay })`
- `tonSignMessage({ addressNList, message })` — signs raw message bytes

Note: hdwallet does not construct TON transactions. The app must build the BOC (Bag of Cells) and extract the signing payload.

## Transaction Format

TON uses a cell-based data structure called BOC (Bag of Cells):
```
External Message {
  destination: InternalAddress
  StateInit: { code, data }  (only for first message to uninitialized contract)
  body: InternalMessage {
    subwallet_id
    valid_until
    seqno
    op: 0 (simple transfer)
    send_mode
    InternalMessage {
      dest, value, body (comment)
    }
  }
}
```

The device signs the **body hash** of the external message. The app constructs the full BOC around the signature.

## RPC Dependencies

- TON HTTP API (e.g., `https://toncenter.com/api/v2`)
- Needed for: account state (seqno), fee estimation, broadcasting
- Alternative: `tonapi.io` for richer data (NFTs, jettons)

## Known Issues / Gotchas

- Address derivation is complex — depends on wallet contract version (v3r2, v4r2, etc.)
- The seqno (sequence number) must be fetched from the chain for each transaction
- Wallet contract must be deployed (first outgoing transaction deploys it via StateInit)
- Jetton (token) transfers are internal messages to the jetton wallet contract
- Ed25519 uses hardened-only derivation path (no unhardened children)
- BOC serialization is non-trivial — use a TON SDK library (tonweb, @ton/core)
