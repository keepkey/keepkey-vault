# Balance Cache: No-Walk-Backwards Audit & Fix

**Date:** 2026-05-17  
**Branch:** `swapping-cleanup`  
**Symptom:** Fresh wallet shows 0 balances; Pioneer cold-cache responses can overwrite real cached balances with 0

---

## The Rule

> A balance we have **seen before and saved in SQLite** must never be replaced by a lower (including zero) value from a transient Pioneer response. Show stale-but-real data with a timestamp rather than wiping to 0.

---

## Root Causes Found

### 1. `setCachedBalances` — blind `INSERT OR REPLACE`

**Before:** `INSERT OR REPLACE INTO balances ...` — SQLite `OR REPLACE` deletes the old row and inserts a new one. A Pioneer response of `balanceUsd: 0` for any chain overwrote the cached value, even if the user had 1 BTC cached.

**Affects:** Full portfolio refresh (`getBalances` RPC). If Pioneer returns 0 for a chain (cold cache, timeout partial result), that 0 is written to SQLite and shown on next load.

### 2. `updateCachedBalance` — same blind `INSERT OR REPLACE`

**Affects:** Single-chain refresh (`getBalance` RPC, also BTC aggregate sync after btc-accounts-update). Same problem.

### 3. `saveCachedPubkey` — defaults balance to `'0'`

**Before:** `balance || '0'` — if the per-xpub balance from Pioneer was missing/undefined, `'0'` was stored. Combined with `INSERT OR REPLACE`, this erased real cached per-xpub balances.

**Affects:** BTC per-account cache; read back during swap routing and `getCachedPubkeys` fallback.

### 4. UI `refreshBalances` — replaced entire map with live result

**Before:**
```typescript
const map = new Map<string, ChainBalance>()
for (const b of result) map.set(b.chainId, b)
setBalances(map)
```

When a Pioneer chunk fails, its chains are absent from `result`. The old `Map` constructor discarded the current in-memory balances, so failed-chunk chains disappeared from the UI for the session (even though they were preserved in DB by the fix above).

---

## Fixes Applied

### `db.ts` — No-walk-backwards upsert (all three write paths)

Changed all three functions from `INSERT OR REPLACE` to `INSERT ... ON CONFLICT DO UPDATE` with conditional column updates:

```sql
INSERT INTO balances (...) VALUES (...)
ON CONFLICT(device_id, chain_id) DO UPDATE SET
  symbol      = excluded.symbol,
  address     = CASE WHEN excluded.address != '' THEN excluded.address ELSE address END,
  balance     = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.balance     ELSE balance     END,
  balance_usd = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.balance_usd ELSE balance_usd END,
  tokens_json = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.tokens_json ELSE tokens_json END,
  updated_at  = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.updated_at  ELSE updated_at  END
```

**Effect:**
- New non-zero balance → row is updated normally (balance, tokens, `updated_at` all advance).
- Pioneer returns 0 but DB has non-zero → only `symbol` and `address` are updated; balance/tokens/timestamp are preserved.
- Row doesn't exist yet → inserted as-is (standard INSERT path, no conflict).
- `updated_at` only advances when the balance is confirmed non-zero → the Dashboard's "X ago · Refresh" accurately shows when the balance was last confirmed, not just when Pioneer was last called.

Applied identically to:
- `setCachedBalances` (full portfolio write, `balances` table)
- `updateCachedBalance` (single-chain upsert, `balances` table)
- `saveCachedPubkey` (per-xpub write, `cached_pubkeys` table, conflict key is `(device_id, chain_id, path)`)

### `types.ts` — `ChainBalance.updatedAt`

Added `updatedAt?: number` to `ChainBalance`. Set by `getCachedBalances` from the `updated_at` DB column. This is the timestamp of the last confirmed non-zero balance for that chain.

### `Dashboard.tsx` — UI-level no-walk-backwards merge

Changed `refreshBalances` to start from the current in-memory `balances` map and merge live results into it, rather than replacing the entire map:

```typescript
const map = new Map<string, ChainBalance>(balances)  // preserve existing
for (const b of result) {
    const prev = map.get(b.chainId)
    if (!prev || b.balanceUsd > 0 || parseFloat(b.balance || '0') > 0) {
        map.set(b.chainId, b)
    } else {
        console.log(`[Dashboard] Preserving prior ${b.chainId} balance — Pioneer returned 0`)
    }
}
setBalances(map)
```

**Effect:** Chains from failed Pioneer chunks remain visible in the UI during the session (using the last-displayed value). They'll be refreshed on the next successful call or app restart (where DB has the correct preserved value).

---

## What Still Clears to Zero (Intentional)

These paths bypass the no-walk-backwards rule and are correct:

| Path | Why intentional |
|------|----------------|
| `clearBalances(deviceId)` | Triggered on seed change — the old seed's balances are wrong for the new seed |
| `deleteDeviceSnapshot(deviceId)` | Device forgotten by user — full wipe expected |
| Factory reset | User explicitly erasing all data |
| `clearCachedPubkeys(deviceId)` | Paired with seed change; same rationale |

---

## How "Last Date in UI" Works

`getCachedBalances` computes `maxUpdatedAt` = max of `updated_at` across all cached chains.  
Dashboard shows this as `cacheUpdatedAt` in the "Refresh" button:
- **Teal**: < 1 hour old
- **Gold**: 1h–24h old  
- **Rose**: > 24h old

With the no-walk-backwards fix, `updated_at` only advances when a chain's balance is confirmed non-zero. If Pioneer returns 0 for a chain (cold cache), `updated_at` stays at the last good confirmation time. So the UI will show "from 3 days ago" if that's when we last confirmed a real balance — which is accurate.

Per-chain `updatedAt` is now available via `ChainBalance.updatedAt` for future UI use (e.g., per-chain stale indicators in the chain list).

---

## Files Changed

| File | Change |
|------|--------|
| `src/bun/db.ts` | `setCachedBalances`, `updateCachedBalance`, `saveCachedPubkey` — no-walk-backwards upsert SQL |
| `src/bun/db.ts` | `getCachedBalances` — include `updatedAt` per chain in returned `ChainBalance` |
| `src/shared/types.ts` | `ChainBalance.updatedAt?: number` |
| `src/mainview/components/Dashboard.tsx` | `refreshBalances` — merge into existing map instead of replacing |
