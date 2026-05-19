# Handoff: Pioneer UTXO endpoints — accept CAIP networkId in addition to symbol

**Date:** 2026-05-18  
**From:** Vault v11  
**To:** Pioneer server (`api-blue.keepkey.info` / `api.keepkey.info`)  
**Priority:** P1 — BTC swap build-preview fails today

---

## Problem

Vault sends CAIP-2 networkIds (e.g. `bip122:000000000019d6689c085ae165831e93`) to several Pioneer UTXO endpoints whose path parameters currently only accept short symbols (`BTC`, `DOGE`, `LTC`, …). The requests silently return empty results instead of erroring, which surfaces as "Build preview failed: No UTXOs found for Bitcoin" even when the wallet has funded UTXOs in cache.

Vault uses CAIPs consistently throughout — hardcoding `'BTC'` or using the Chain enum is a code smell we want to eliminate. Pioneer needs to understand both formats.

---

## Affected endpoints

| operationId | Route | Current param format |
|---|---|---|
| `ListUnspent` | `GET /utxo/unspent/{network}/{xpub}` | symbol only (`BTC`) |
| `GetPubkeyInfo` | `GET /utxo/pubkey-info/{network}/{xpub}` | symbol only (`BTC`) |
| `GetChangeAddress` | `GET /utxo/change-address/{network}/{xpub}` | symbol only (`BTC`) |
| `GetBalanceByXpub` | `GET /utxo/balance/{network}/{xpub}` | symbol only (`BTC`) |
| `GetFees` | `GET /utxo/fees/{network}` | symbol only (`BTC`) |

Already correct (no change needed):

| operationId | Route |
|---|---|
| `GetFeeRate` | `GET /utxo/fee-rate/{networkId}` — already CAIP-only |
| `LookupUtxoTx` | `GET /utxo/lookup/{networkId}/{txid}` — already CAIP-only |

---

## Required fix (backwards-compatible)

In the route handler for each affected endpoint, before looking up the network/blockbook backend, normalise the `{network}` path segment:

```
if network contains ':':
    # it's a CAIP-2 networkId — map to symbol
    network = caip_to_symbol(network)
# else it's already a symbol — proceed as before
```

### CAIP → symbol mapping for UTXO chains

| CAIP-2 networkId | Symbol |
|---|---|
| `bip122:000000000019d6689c085ae165831e93` | `BTC` |
| `bip122:12a765e31ffd4059bada1e25190f6e98` | `LTC` |
| `bip122:00000000001a91e3dace36e2be3bf030` | `DOGE` |
| `bip122:000000000000000000651ef99cb9fcbe` | `BCH` |
| `bip122:000007d91d1254d60e2dd1ae58038307` | `DASH` |
| `bip122:00040fe8ec8471911baa1db1266ea15d` | `ZEC` |
| `bip122:4da631f2ac1bed857bd968c67c913978` | `DGB` |

Return `400 Bad Request` if the CAIP is unrecognised (don't silently return `[]`).

---

## Vault call sites (for reference)

These are the exact locations that will send CAIP networkIds once Pioneer handles them. All are currently broken and blocked by this issue.

**`src/bun/txbuilder/utxo.ts`**
- `fetchUtxosForXpub(pioneer, chain.networkId, ...)` — called from `buildUtxoTx` and `estimateUtxoFee` (4 call sites, lines ~197, 201, 269, 280)
- `pioneer.GetPubkeyInfo({ network: chain.chain, ... })` line 417 — currently uses `chain.chain` (symbol); once Pioneer accepts CAIP this should be updated to `chain.networkId` for consistency

**`src/bun/sweep-engine.ts`**
- `pioneer.ListUnspent({ network: BTC_NETWORK_ID, ... })` line 202 — `BTC_NETWORK_ID = 'bip122:000000000019d6689c085ae165831e93'`

**`src/bun/reports.ts` and `src/bun/index.ts`**
- `pioneer.GetPubkeyInfo({ network: 'BTC', xpub })` — hardcoded symbol; once Pioneer accepts CAIP these will be migrated to `chain.networkId`

---

## Verification

After deploying, confirm:

```bash
# Should return UTXOs (same as /utxo/unspent/BTC/<zpub>)
curl "https://api-blue.keepkey.info/utxo/unspent/bip122:000000000019d6689c085ae165831e93/<zpub>"

# Should still work (backwards compat)
curl "https://api-blue.keepkey.info/utxo/unspent/BTC/<zpub>"

# Unknown CAIP — should 400, not []
curl "https://api-blue.keepkey.info/utxo/unspent/bip122:deadbeef/<zpub>"
```

After Pioneer is deployed, vault call sites above can be cleaned up to use `chain.networkId` uniformly.
