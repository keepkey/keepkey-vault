# Handoff: Pioneer — BTC Multi-Xpub Balance Missing

**Date**: 2026-05-16  
**Branch**: `swapping-cleanup` (vault fixes already committed)  
**Vault path**: `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/`  
**Pioneer path**: `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer/`

---

## The Problem

The vault's swap UI shows AVAILABLE BTC as one account's balance instead of the sum across all three account types (Legacy/SegWit/NativeSegWit). The cache in SQLite:

```
chain_id=bitcoin | balance=0.00020865 | address=zpub6rXHd37…
```

Expected sum from `cached_pubkeys` table:
| xpub prefix | balance |
|---|---|
| xpub (Legacy p2pkh) | 0.00000000 |
| ypub (SegWit p2sh-p2wpkh) | 0.00063913 |
| zpub (NativeSegWit p2wpkh) | 0.00017924 |
| **Total** | **0.00081837** |

---

## Root Cause — Two Layers

### Layer 1: Pioneer `GetPortfolioBalances` doesn't echo back all 3 pubkeys

The vault sends all 3 xpubs to `GetPortfolioBalances`:
```json
{ "pubkeys": [
  { "caip": "bip122:…/slip44:0", "pubkey": "xpub6CXwX…" },
  { "caip": "bip122:…/slip44:0", "pubkey": "ypub6XKTa…" },
  { "caip": "bip122:…/slip44:0", "pubkey": "zpub6rXHd…" }
]}
```

Vault match logic (`index.ts` line ~2006):
```typescript
const match = pureNatives.find((d: any) => d.pubkey === entry.pubkey)
    || pureNatives.find((d: any) => d.caip === entry.caip && d.address === entry.pubkey)
```

From the log, **only the zpub matched**:
```
[getBalances] BTC match for zpub6rXHd37fxCQN5Rn5...: balance=0.00017924, usd=14.03
```

No match lines for xpub or ypub, meaning Pioneer's response did not include entries with `pubkey` = the submitted xpub/ypub strings. 

**Either Pioneer is:**
1. Only returning a balance entry for the LAST submitted xpub (order-dependent bug), or
2. Aggregating all 3 into a single entry keyed by one pubkey (probably the last/first), or
3. Not echoing back the `pubkey` field on entries for xpub/ypub prefix types

### Layer 2: Vault cache update blocked by Pioneer timeouts

In `index.ts` line 2166:
```typescript
if (results.length > 0 && !hadChunkFailures && !engine.isPassphraseWallet)
  setCachedBalances(deviceId, results)
```

A Pioneer timeout (observed in logs — `[ERROR] | Client | Operation error: Request timed out`) sets `hadChunkFailures = true`, so the cache is NEVER written even when partial data arrived. The UI then reads the stale 2-hour-old single-xpub value from DB.

---

## What to Investigate in Pioneer

### 1. `GetPortfolioBalances` endpoint
File: likely `pioneer-server/src/routes/portfolio.ts` or similar  
Method: `POST /portfolio/balances`  
Swagger op: `GetPortfolioBalances`

**Questions:**
- When 3 xpubs with the SAME caip are submitted, does the server return 3 separate response entries each with `pubkey` echoed back?
- Or does it query a shared address set and return aggregated/deduplicated results?
- Does it return `pubkey` in each response entry? If not, the vault can't match.

**Expected response shape** (what vault needs):
```json
[
  { "pubkey": "xpub6CXwX…", "caip": "bip122:…", "balance": "0", "valueUsd": 0 },
  { "pubkey": "ypub6XKTa…", "caip": "bip122:…", "balance": "0.00063913", "valueUsd": 49.97 },
  { "pubkey": "zpub6rXHd…", "caip": "bip122:…", "balance": "0.00017924", "valueUsd": 14.01 }
]
```

Each entry must echo back the submitted `pubkey` so the vault can match and aggregate.

### 2. Reproduce the mismatch
```bash
# Hit Pioneer directly with the 3 xpubs
curl -X POST https://api.keepkey.info/api/v1/portfolio/balances \
  -H "Content-Type: application/json" \
  -d '{
    "pubkeys": [
      {"caip":"bip122:000000000019d6689c085ae165831e93/slip44:0","pubkey":"xpub6CXwXedtSY8ng1P8XULzYzFTJFujJamcKXaXDnBJzGYB7P56W1bkZLxeHmrAs9bmVgb9pbV9STMoiE6oyxs8DpvFuuYNKnxR4MrSM5aqgTp"},
      {"caip":"bip122:000000000019d6689c085ae165831e93/slip44:0","pubkey":"ypub6XKTae3tTEUCB6WaWVuHxJYYxoAw7uMthRfRrYSnnSvkFjksZfjG4igK1tvQRvejWVPjSrvU8DTPqkED6LRnxCwNkf77WPTD9xACU9REzDh"},
      {"caip":"bip122:000000000019d6689c085ae165831e93/slip44:0","pubkey":"zpub6rXHd37fxCQN5Rn5cVtP64gg1xosZ5KA3jomifTN7dWKQCY64PSbDXT3ehyG5kWbQfVCmb5ZhjyvSDUYx1jvDrxtb2B7wvSjdgPsjWKYnwB"}
    ]
  }'
```

**Verify:** Does the response contain 3 entries, each with `pubkey` field matching the submitted value?

### 3. If Pioneer aggregates BTC xpubs
Pioneer may normalize all 3 xpubs to the same underlying address set (BIP32 derivation path is the same, just different output encoding xpub/ypub/zpub). Fix options:
  - **Server-side**: Echo back the submitted `pubkey` on each response entry
  - **Server-side**: Return one entry per submitted pubkey (even if same underlying path), with the specific script-type balance

---

## Vault-Side Fallback (Already Available, Not Yet Used)

As a defensive measure independent of the Pioneer fix, the vault's matching could fall back to `cached_pubkeys` DB balances when Pioneer doesn't return a match for a submitted xpub. The `cached_pubkeys` table stores per-xpub balances updated on each successful Pioneer response:

```
bitcoin | ypub6XKTae3t… | balance=0.00063913 | balance_usd=49.97
bitcoin | zpub6rXHd37fx… | balance=0.00017924 | balance_usd=14.01
```

If the vault sees `match === undefined` for an xpub, it could use `getCachedPubkeys(devId).find(p => p.xpub === entry.pubkey)` as fallback. This is a vault-side mitigation — the Pioneer fix is still needed for accuracy.

---

## Vault Fixes Already in `swapping-cleanup` Branch

| Fix | File | Description |
|---|---|---|
| `buyAsset.address` populated | `swap-tracker.ts` | ETH address from walletId sent to Pioneer |
| `localRefundOverridesPioneer` | `swap-tracker.ts` | Pioneer "completed" can't override local "refunded" |
| NEAR Intents min amount guard | `swap.ts`, `swap-parsing.ts` | Throws before signing if amount < minAmountIn |
| Pioneer timeout protection | `swap-tracker.ts` | 30s timeout on all GetPendingSwap/CreatePendingSwap calls |
| Aggregate BTC balance in UI | `AssetPage.tsx` | Swap+send panels now receive btcAccounts.totalBalance |

---

## Wallet Under Test

- Device: `343737340F4736331F003B00`
- BTC xpubs (all account 0):
  - Legacy: `xpub6CXwXedtSY8ng1P8XULzYzFTJFujJamcKXaXDnBJzGYB7P56W1bkZLxeHmrAs9bmVgb9pbV9STMoiE6oyxs8DpvFuuYNKnxR4MrSM5aqgTp`
  - SegWit: `ypub6XKTae3tTEUCB6WaWVuHxJYYxoAw7uMthRrRrYSnnSvkFjksZfjG4igK1tvQRvejWVPjSrvU8DTPqkED6LRnxCwNkf77WPTD9xACU9REzDh`
  - NativeSegWit: `zpub6rXHd37fxCQN5Rn5cVtP64gg1xosZ5KA3jomifTN7dWKQCY64PSbDXT3ehyG5kWbQfVCmb5ZhjyvSDUYx1jvDrxtb2B7wvSjdgPsjWKYnwB`
- Vault DB: `/Users/highlander/Library/Application Support/com.keepkey.vault/dev/vault.db`
- Pioneer server: `https://api.keepkey.info` (reset from blue; use `make start` in pioneer dir)

---

## Definition of Done

- [ ] Pioneer `GetPortfolioBalances` returns a separate response entry for each submitted BTC xpub, with `pubkey` echoed back
- [ ] Vault's "AVAILABLE" in swap dialog shows ~0.00081837 BTC (sum of all 3 accounts)
- [ ] `api/debug/portfolio` endpoint shows `bitcoin.balance ≈ 0.00081837` after a fresh `getBalances` RPC call
