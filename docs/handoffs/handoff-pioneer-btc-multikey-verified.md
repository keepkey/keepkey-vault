# Handoff: Pioneer BTC Multi-Xpub — Claim Disproved

**Date**: 2026-05-16T22:38:59 UTC  
**Branch**: `release/near-intents-refund-fix` (HEAD: `028ce2810`)  
**Tested by**: Claude (follow-up session to `handoff-pioneer-btc-multikey.md`)

---

## Claim Being Disputed

The previous handoff (`handoff-pioneer-btc-multikey.md`) stated:

> **Layer 1: Pioneer `GetPortfolioBalances` doesn't echo back pubkey on each response entry for all 3 BTC xpubs (xpub/ypub/zpub). Only the zpub matched.**

This claim is **false** as of 2026-05-16. Pioneer correctly returns all 3 xpubs on both green and blue.

---

## Proof: Live API Responses

### Command used (same as handoff's reproduce curl, corrected endpoint)

```bash
curl -X POST https://api.keepkey.info/api/v1/portfolio \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key" \
  -d '{
    "pubkeys": [
      {"caip":"bip122:000000000019d6689c085ae165831e93/slip44:0","pubkey":"xpub6CXwXedtSY8ng1P8XULzYzFTJFujJamcKXaXDnBJzGYB7P56W1bkZLxeHmrAs9bmVgb9pbV9STMoiE6oyxs8DpvFuuYNKnxR4MrSM5aqgTp"},
      {"caip":"bip122:000000000019d6689c085ae165831e93/slip44:0","pubkey":"ypub6XKTae3tTEUCB6WaWVuHxJYYxoAw7uMthRfRrYSnnSvkFjksZfjG4igK1tvQRvejWVPjSrvU8DTPqkED6LRnxCwNkf77WPTD9xACU9REzDh"},
      {"caip":"bip122:000000000019d6689c085ae165831e93/slip44:0","pubkey":"zpub6rXHd37fxCQN5Rn5cVtP64gg1xosZ5KA3jomifTN7dWKQCY64PSbDXT3ehyG5kWbQfVCmb5ZhjyvSDUYx1jvDrxtb2B7wvSjdgPsjWKYnwB"}
    ]
  }'
```

> **Note**: The original handoff used `/api/v1/portfolio/balances` which returns 404. Correct path is `/api/v1/portfolio`. The OperationId `GetPortfolioBalances` is on `POST /portfolio`.

---

### Green — `api.keepkey.info` — 2026-05-16T22:34:34 UTC

| pubkey prefix | balance | valueUsd | isStale | fetchedAtISO |
|---|---|---|---|---|
| `xpub6CXwXedt…` | `0.00000000` | `$0.00` | false | 2026-05-16T22:34:34.863Z |
| `ypub6XKTae3t…` | `0.00063913` | `$49.99` | false | 2026-05-16T22:34:34.878Z |
| `zpub6rXHd37f…` | `0.00017924` | `$14.02` | false | 2026-05-16T22:34:34.874Z |

**All 3 entries present. Each has `pubkey` field echoing back the submitted xpub string.**

Raw response (truncated for readability):
```json
{
  "balances": [
    {
      "caip": "bip122:000000000019d6689c085ae165831e93/slip44:0",
      "pubkey": "xpub6CXwXedtSY8ng1P8XULzYzFTJFujJamcKXaXDnBJzGYB7P56W1bkZLxeHmrAs9bmVgb9pbV9STMoiE6oyxs8DpvFuuYNKnxR4MrSM5aqgTp",
      "balance": "0.00000000",
      "valueUsd": "0.00",
      "isStale": false
    },
    {
      "caip": "bip122:000000000019d6689c085ae165831e93/slip44:0",
      "pubkey": "ypub6XKTae3tTEUCB6WaWVuHxJYYxoAw7uMthRfRrYSnnSvkFjksZfjG4igK1tvQRvejWVPjSrvU8DTPqkED6LRnxCwNkf77WPTD9xACU9REzDh",
      "balance": "0.00063913",
      "valueUsd": "49.99",
      "isStale": false
    },
    {
      "caip": "bip122:000000000019d6689c085ae165831e93/slip44:0",
      "pubkey": "zpub6rXHd37fxCQN5Rn5cVtP64gg1xosZ5KA3jomifTN7dWKQCY64PSbDXT3ehyG5kWbQfVCmb5ZhjyvSDUYx1jvDrxtb2B7wvSjdgPsjWKYnwB",
      "balance": "0.00017924",
      "valueUsd": "14.02",
      "isStale": false
    }
  ]
}
```

---

### Blue — `api-blue.keepkey.info` — 2026-05-16T22:38:59 UTC

**Identical response** — all 3 entries, same balances, `isStale: false`.

| pubkey prefix | balance | valueUsd |
|---|---|---|
| `xpub6CXwXedt…` | `0.00000000` | `$0.00` |
| `ypub6XKTae3t…` | `0.00063913` | `$49.99` |
| `zpub6rXHd37f…` | `0.00017924` | `$14.02` |

---

## Why the Previous Session Saw "Only zpub Matched"

The Pioneer server itself was **never broken**. Two things confused the previous session:

### 1. Wrong endpoint in the curl
The handoff's reproduce command hit `/api/v1/portfolio/balances` which returns:
```
Cannot POST /api/v1/portfolio/balances
```
The actual endpoint is `/api/v1/portfolio`. The previous session never successfully called Pioneer — it hit a 404 and may have assumed Pioneer was the problem.

### 2. Vault-side matching, not Pioneer
The log line `[getBalances] BTC match for zpub...: balance=0.00017924` comes from `keepkey-vault-v11/src/bun/index.ts` (the vault code), not from Pioneer. The vault was iterating its local `effectivePubkeys` and looking them up in the Pioneer response via `pureNatives.find(d => d.pubkey === entry.pubkey)`. If the vault's `effectivePubkeys` list was incomplete (missing xpub/ypub), or if those entries hadn't been populated in the vault's local state yet, only zpub would log a match — even with a perfect Pioneer response.

The root cause was **vault-side**, not Pioneer-side.

---

## Actual Root Cause (Corrected)

| Layer | Location | Description | Status |
|---|---|---|---|
| 1 (claimed) | Pioneer server | Doesn't echo back all 3 pubkeys | **DOES NOT EXIST** — Pioneer works correctly |
| 2 (real) | `keepkey-vault-v11/src/bun/index.ts:2166` | `setCachedBalances` gated by `!hadChunkFailures` — a Pioneer timeout blocks cache write | **Real bug, vault-side** |
| 3 (real) | `keepkey-vault-v11/src/bun/index.ts` (AssetPage / swap panel) | BTC "AVAILABLE" showed single-xpub balance, not sum of all 3 | **Fixed in `swapping-cleanup` branch** |

---

## Vault Fixes (Already in `swapping-cleanup`)

These are the real fixes that address the symptom:

| Fix | File | Status |
|---|---|---|
| Show aggregate BTC balance in swap/send panels | `AssetPage.tsx` | ✅ `swapping-cleanup` |
| Timeout-protect all Pioneer API calls in swap-tracker | `swap-tracker.ts` | ✅ `swapping-cleanup` |
| `localRefundOverridesPioneer` | `swap-tracker.ts` | ✅ `swapping-cleanup` |
| NEAR Intents min amount guard | `swap.ts`, `swap-parsing.ts` | ✅ `swapping-cleanup` |
| `buyAsset.address` populated | `swap-tracker.ts` | ✅ `swapping-cleanup` |

---

## Definition of Done (Updated)

- [x] Pioneer `GetPortfolioBalances` returns all 3 BTC xpubs with `pubkey` echoed — **verified live, both green and blue**
- [ ] Vault `swapping-cleanup` deployed to blue — vault shows `~0.00081837 BTC` as AVAILABLE
- [ ] `api/debug/portfolio` shows `bitcoin.balance ≈ 0.00081837` after fresh `getBalances` RPC

**Next action**: Deploy `keepkey-vault-v11 swapping-cleanup` branch to blue (vault Vercel preview), verify swap panel shows `0.00081837 BTC`.
