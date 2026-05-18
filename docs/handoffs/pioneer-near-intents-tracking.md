# Pioneer Handoff: NEAR Intents Swap Tracking

## Summary

NEAR Intents BTC→EVM swaps execute successfully at the BTC layer but Pioneer cannot
track them to completion. Two bugs cause this:

1. **Integration enum validator** rejects the vault's registration call
2. **Protocol mismatch** — Pioneer identifies NEAR Intents txs as THORChain and never finds an outbound

---

## Bug 1: CreatePendingSwap rejects `nearIntents` integration

### Symptom
```
POST https://api.keepkey.info/api/v1/swaps/pending
400 Bad Request
{
  "body.integration": {
    "message": "should be one of the following; ['thorchain','mayachain','osmosis','uniswap','rango','chainflip','changelly','relay','shapeshift']",
    "value": "nearIntents"
  }
}
```

### When it happens
Every NEAR Intents BTC→ETH swap executed from the vault. The quote endpoint returns
`integration: 'nearIntents'`; the vault forwards this to CreatePendingSwap.

### Fix needed
Add `nearIntents` to the allowed integration enum, OR have the validator treat it as
an alias for `shapeshift` (NEAR Intents is a ShapeShift product).

**Vault-side workaround already applied** (v1.3.6+): the vault maps `nearIntents →
shapeshift` before calling CreatePendingSwap. This masks the registration error but
does not fix Pioneer's swap monitor (see Bug 2).

---

## Bug 2: Protocol misidentification — Pioneer tracks as THORChain

### Symptom
After receiving the CreatePendingSwap call (or self-discovering the tx on-chain),
Pioneer's `GetPendingSwap` response shows:
```json
{
  "status": "processing",
  "details": {
    "protocol": {
      "protocol": "thorchain",
      "status": "unknown",
      "inboundTxHash": "292ddbb5...",
      "isRefund": false
    }
  }
}
```

Pioneer sees the BTC confirmation (`confirmations: 7`) but runs the THORChain monitor
which will never find a THORChain outbound tx — so the swap stays `processing /
unknown` forever.

### Root cause
NEAR Intents is **not** a THORChain swap. It uses a deposit channel:
- Vault sends BTC to a deposit channel address (e.g. `bc1qpnjfy6zyuntvhlev...`)
- A NEAR Intents solver fronts ETH to the recipient
- The solver claims the BTC after 2 confirmations

There is no THORChain memo. Pioneer's protocol detector defaults to `thorchain` for
unknown BTC sends.

### Fix needed
Pioneer needs a NEAR Intents protocol monitor. Inputs to identify the swap:

| Field | Value |
|-------|-------|
| integration | `shapeshift` (or `nearIntents` if enum is extended) |
| swapper | `NEAR Intents` |
| sellCaip | `bip122:000000000019d6689c085ae165831e93/slip44:0` (BTC) |
| buyCaip | EVM chain (e.g. `eip155:1/slip44:60` for ETH) |
| memo | empty / absent |
| inboundAddress | BTC deposit channel address |

**To check if a NEAR Intents swap was delivered:**

Option A — NEAR Intents status API (preferred):
- The deposit channel address is the key for their status endpoint

Option B — on-chain check:
1. `GET https://mempool.space/api/address/{inboundAddress}/utxo`
2. If the UTXO list is empty, the solver swept the deposit → BTC was claimed
3. Then check the EVM chain for ETH delivered to `buyAsset.address` after BTC confirmation block time

---

## Confirmed Stuck Swap (May 18, 2026)

A real BTC→ETH NEAR Intents swap completed at the BTC layer but Pioneer has no record
of the ETH delivery.

```
txHash:   292ddbb5ce05a769586a46cd1608cdc81dabe47974da982930e0b795eb69fa20
source:   bc1qq7dgn034yxlqulvnxwupyd7gc3smzqu0v9hzg4
deposit:  bc1qpnjfy6zyuntvhlevmmc6wy7rpq369t6xggqmkh (NEAR Intents deposit channel)
amount:   75,654 sat deposited in block 949962
dest:     ETH on Ethereum to 0x9f5f2e605863dc1D9CCB98BC104E10fD551d8eE9
```

**On-chain confirmed (mempool.space):**
- Block 949965 (3 blocks after deposit): solver swept the deposit channel in batch tx
  `1dbdc5f196dbf390eadaf55f923c83056407013e0d4254cf3f3ab0cb5eeb49b`
  alongside 24 other deposit channels → aggregation address `bc1qp42j7hn3lup7gck6y6eks6x2lmnp800t6gy7sk`
- This is a NEAR Intents solver batch aggregation — normal completion behavior

**ETH delivery status (checked May 18, 2026):**
- `0x9f5f2e605863dc1D9CCB98BC104E10fD551d8eE9` — 0 ETH balance, no transaction history (Etherscan)
- ETH was NOT delivered to the expected destination
- Status is ambiguous: solver took BTC but ETH never arrived. Either delivered elsewhere, refunded on NEAR, or pending solver settlement.

**Pioneer response:**
```json
{
  "status": "processing",
  "confirmations": 7,
  "details": { "protocol": { "protocol": "thorchain", "status": "unknown" } }
}
```

**Action needed:** Pioneer should check NEAR Intents status API for this deposit channel
and either mark it `completed` (with ETH outbound txid) or `refunded` (with BTC refund txid).

---

## Related: EVM address returned as BTC inbound (May 16, 2026)

Pioneer's quote endpoint sometimes returns an EVM address as `inboundAddress` for
BTC→EVM NEAR Intents quotes. The vault guard (`swap-parsing.ts`) catches this and
throws before execution, so no BTC is sent. But the guard causes a confusing user
error ("deposit channel may be unavailable").

Vault log: `ERR: [swap] NEAR Intents BTC deposit address is missing — Pioneer returned
EVM address 0x9f5f2e605863dc1D9CCB98BC104E10fD551d8eE9 as inbound address for a UTXO
source.`

Pioneer should always return a valid Bitcoin address as `inboundAddress` for UTXO
source NEAR Intents quotes.

---

## Test Vectors

**Successful BTC broadcast, ETH delivery unknown (May 18)**
- BTC txid: `292ddbb5ce05a769586a46cd1608cdc81dabe47974da982930e0b795eb69fa20`
- Source UTXO: `c28e84806cdc85a91de564e13827b48de19c3bc8370ecb93e1774f6637f74519:0`
- Amount: 75,654 sat (0.00075654 BTC after fee)
- Deposit channel: `bc1qpnjfy6zyuntvhlevmmc6wy7rpq369t6xggqmkh`
- Solver sweep tx: `1dbdc5f196dbf390eadaf55f923c83056407013e0d4254cf3f3ab0cb5eeb49b` (block 949965)
- ETH recipient: `0x9f5f2e605863dc1D9CCB98BC104E10fD551d8eE9` (Ethereum mainnet)

**Failed BTC broadcast — wrong address type (May 16)**
- Error: Pioneer returned `0x9f5f2e605863dc1D9CCB98BC104E10fD551d8eE9` as `inboundAddress` for a BTC source
- Expected: a bech32 Bitcoin address

---

## Priority

| Bug | Impact | Fix owner |
|-----|--------|-----------|
| Protocol misidentification (THORChain) | Every NEAR Intents swap stuck forever | Pioneer |
| Integration enum rejects `nearIntents` | Registration fails (vault works around it) | Pioneer |
| EVM address returned as BTC inbound | Swap blocked with confusing error | Pioneer |
