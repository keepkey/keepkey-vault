# Handoff: Pioneer BTC Transaction History — Cold Cache Bug

**Date:** 2026-05-18  
**Diagnosed by:** vault team  
**Target:** Pioneer server (`keepkey/pioneer`)

---

## Problem

When a user selects BTC and hits "Refresh History" in the vault, no transactions appear — even for wallets with real on-chain history. The vault's activity panel stays empty.

## Root Cause: Pioneer Side (confirmed)

Pioneer's `POST /api/v1/tx/history` only returns transactions when the xpub is **already in Pioneer's cache**. For a cold (first-time or cache-expired) xpub it returns:

```json
{"success":true,"histories":[{"transactions":[],"fresh":false,"cached":false,...}]}
```

…even when the xpub has real history on-chain.

### Proof

Test xpub with known real history (~$60, 8 txs):
```
zpub6rXHd37fxCQN5Rn5cVtP64gg1xosZ5KA3jomifTN7dWKQCY64PSbDXT3ehyG5kWbQfVCmb5ZhjyvSDUYx1jvDrxtb2B7wvSjdgPsjWKYnwB
```
CAIP: `bip122:000000000019d6689c085ae165831e93/slip44:0`

**Cold call (first-time xpub):**
```bash
curl -X POST "https://api.keepkey.info/api/v1/tx/history" \
  -H "Content-Type: application/json" \
  -d '{"queries":[{"pubkey":"zpub6rXH...nwB","caip":"bip122:000000000019d6689c085ae165831e93/slip44:0"}]}'
# → transactions: [], fresh: false, cached: false
```

**After cache is warm:**
```bash
# Same request → transactions: [8 txs], fresh: true, cached: true
```

**With `forceRefresh=true`:**
```bash
curl -X POST "https://api.keepkey.info/api/v1/tx/history?forceRefresh=true" ...
# → transactions: [], fresh: false, cached: false  ← ALSO BROKEN
```

## Two Bugs to Fix in Pioneer

### Bug 1 (P0): Cold cache returns empty instead of fetching
`GET /api/v1/tx/history` with an uncached xpub should trigger a fetch from the blockchain indexer (Blockbook/Electrum/etc.) before responding — not return empty. Currently it only serves from Redis; if the key is missing it returns `[]`.

**Fix:** In the `GetTransactionHistory` handler, if `cached:false`, fetch from the UTXO indexer synchronously before responding (or trigger + await the cache population).

### Bug 2 (P1): `forceRefresh=true` returns empty for zpubs
Passing `?forceRefresh=true` should bypass cache and fetch live from the indexer. Instead it returns `fresh:false, cached:false, transactions:[]`. This suggests the forceRefresh path fails silently for zpub-format keys (possibly the indexer call errors out and the handler swallows the error and returns empty).

**Fix:** Add error logging in the `forceRefresh` path. Check if the UTXO indexer supports zpub format natively or needs conversion to the underlying scriptPubKey set first.

## Vault Side: No Change Needed

The vault correctly calls `pioneer.GetTransactionHistory({ queries: [{pubkey: xpub, caip}] })` for each BTC script type (native segwit zpub, p2sh ypub, legacy xpub). The response parsing in `unwrapHistoryTransactions()` correctly handles `histories[].transactions`. The vault code is not the problem.

## How to Test the Fix

```bash
# 1. Clear Pioneer's cache for this xpub first:
curl -X DELETE "https://api.keepkey.info/api/v1/tx/history/cache/clear" ...

# 2. Cold call — should now return 8 txs:
curl -X POST "https://api.keepkey.info/api/v1/tx/history" \
  -H "Content-Type: application/json" \
  -d '{"queries":[{"pubkey":"zpub6rXHd37fxCQN5Rn5cVtP64gg1xosZ5KA3jomifTN7dWKQCY64PSbDXT3ehyG5kWbQfVCmb5ZhjyvSDUYx1jvDrxtb2B7wvSjdgPsjWKYnwB","caip":"bip122:000000000019d6689c085ae165831e93/slip44:0"}]}'
# Expected: transactions.length > 0, fresh: true, cached: false

# 3. forceRefresh=true — should return same txs:
curl -X POST "https://api.keepkey.info/api/v1/tx/history?forceRefresh=true" \
  -H "Content-Type: application/json" \
  -d '{"queries":[{"pubkey":"zpub6rXHd37fxCQN5Rn5cVtP64gg1xosZ5KA3jomifTN7dWKQCY64PSbDXT3ehyG5kWbQfVCmb5ZhjyvSDUYx1jvDrxtb2B7wvSjdgPsjWKYnwB","caip":"bip122:000000000019d6689c085ae165831e93/slip44:0"}]}'
# Expected: transactions.length > 0, fresh: true

# 4. Repeat with ypub and xpub formats for same wallet (p2sh and legacy accounts)
```

## Transaction Shape (for reference)

Pioneer returns transactions in this format — vault's `normalizeMeta()` and `normalizeActivityType()` handle it correctly:

```json
{
  "txid": "292ddbb5...",
  "caip": "bip122:000000000019d6689c085ae165831e93/slip44:0",
  "direction": "sent",
  "type": "transfer",
  "status": "confirmed",
  "blockHeight": 949962,
  "timestamp": 1779120668,
  "confirmations": 3,
  "value": "75654",
  "fee": "2496",
  "from": ["bc1qq7..."],
  "to": ["bc1qpn..."],
  "swapMetadata": { ... }  // present on swap txs
}
```
