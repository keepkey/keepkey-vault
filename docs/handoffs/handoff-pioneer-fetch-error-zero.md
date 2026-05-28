# Handoff: Pioneer — fetch failures silently return balance="0"

Repo: `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer`  
Related vault PR: https://github.com/keepkey/keepkey-vault/pull/178  
Priority: P1 — vault cannot distinguish "user spent to zero" from "RPC was down"

---

## Root cause (confirmed in source)

`fetchFresh` in `pioneer-cache/src/stores/balance-cache.ts` **correctly** throws when a chain's
RPC is unreachable (line 158-160):

```typescript
if (balanceInfo?.error || balanceInfo === null || balanceInfo === undefined) {
    log.warn(tag, `Balance fetch failed ...`);
    throw new Error(`Failed to fetch balance for ${caip}: ${errorMsg}`);
}
```

But `getBatchBalances` (same file) catches that thrown error in **two places** and silently
returns `{ balance: '0' }` instead of propagating the failure:

**Lines 330-339** (forceRefresh / waitForFresh path):
```typescript
} catch (error) {
    log.error(tag, `Failed to fetch fresh ${item.caip}/${item.pubkey}:`, error);
    const now = Date.now();
    return {
        caip: item.caip,
        pubkey: item.pubkey,
        balance: '0',          // ← RPC failure silently becomes "zero balance"
        fetchedAt: now,
        fetchedAtISO: new Date(now).toISOString()
    };
}
```

**Lines 440-449** (cache-miss fetch path):
```typescript
} catch (error) {
    log.error(tag, `Failed to fetch ${item.caip}/${item.pubkey}:`, error);
    const now = Date.now();
    results[item.index] = {
        caip: item.caip,
        pubkey: item.pubkey,
        balance: '0',          // ← same silent zero
        fetchedAt: now,
        fetchedAtISO: new Date(now).toISOString()
    };
}
```

The `isStale` flag (computed in `balance.controller.ts:732`) is based only on `fetchedAt`
timestamp — since both catch blocks set `fetchedAt: now`, the response arrives at the vault
with `isStale: false, balance: "0"` and is indistinguishable from a genuine empty address.

---

## The fix

**Option A (recommended): omit failed entries from the response**

On fetch failure, return/set `null` and filter nulls before returning from `getBatchBalances`.
The vault already treats "missing from response" correctly (preserves old cached value).
No vault-side changes needed beyond the ones already in PR #178.

**Lines 330-339** — change return value:
```typescript
} catch (error) {
    log.error(tag, `Failed to fetch fresh ${item.caip}/${item.pubkey}:`, error);
    return null;   // omit — vault will preserve last-known balance
}
```

Then filter at the call site (line 343):
```typescript
const results = (await Promise.all(fetchPromises)).filter(r => r !== null);
```

**Lines 440-449** — change result assignment:
```typescript
} catch (error) {
    log.error(tag, `Failed to fetch ${item.caip}/${item.pubkey}:`, error);
    // Leave results[item.index] as the placeholder — but mark it as fetchError
    results[item.index] = null as any;
}
```

Then before `return results` at line 467, filter:
```typescript
return results.filter(r => r !== null);
```

**Option B (if omission breaks existing consumers): add `fetchError: true` flag**

```typescript
return {
    caip: item.caip,
    pubkey: item.pubkey,
    balance: '0',
    fetchedAt: now,
    fetchedAtISO: new Date(now).toISOString(),
    fetchError: true,   // signals: do not cache this zero, RPC was unreachable
};
```

Vault would then skip caching entries with `fetchError: true`.
Requires threading `fetchError` through `BalanceData` type → controller response shape → vault parsing.

---

## What the vault does after this fix

With Option A in place, the vault-side fix in `db.ts` becomes a simple unconditional upsert:

```sql
-- All entries in results are real Pioneer values (even if zero)
-- Missing entries (RPC failure) were never included in results
ON CONFLICT(device_id, chain_id) DO UPDATE SET
  balance     = excluded.balance,
  balance_usd = excluded.balance_usd,
  tokens_json = excluded.tokens_json,
  updated_at  = excluded.updated_at
```

And `Dashboard.tsx` merge becomes:
```typescript
const map = new Map<string, ChainBalance>(balances)  // preserve all current
for (const b of result) map.set(b.chainId, b)        // overwrite only returned chains
setBalances(map)
```

Chains whose RPC was down are absent from `result` → old value stays. Chains that returned
zero balance (genuine empty address) ARE in `result` → zero is written. Clean separation.

---

## Test plan

| Scenario | Before fix | After fix |
|---|---|---|
| Chain RPC down, `forceRefresh=true` | Returns `{balance:"0", isStale:false}` | Entry omitted from response |
| Chain RPC down, cache miss | Returns `{balance:"0", isStale:false}` | Entry omitted from response |
| Chain genuinely empty (fresh wallet) | Returns `{balance:"0", isStale:false}` | Returns `{balance:"0", isStale:false}` ✓ |
| Chain has balance, RPC up | Returns `{balance:"X", isStale:false}` | Returns `{balance:"X", isStale:false}` ✓ |

Concrete test: take a chain (e.g. Optimism) whose RPC is unreachable, call
`GetPortfolioBalances` with `forceRefresh=true`. With the fix, that chain should not
appear in the response array. Without the fix, it appears with `balance="0.00000000"`.

---

## Files

| File | Change |
|---|---|
| `modules/pioneer/pioneer-cache/src/stores/balance-cache.ts:330-339` | Return null on fetch failure (waitForFresh path) |
| `modules/pioneer/pioneer-cache/src/stores/balance-cache.ts:440-449` | Set null on fetch failure (cache-miss path) |
| `modules/pioneer/pioneer-cache/src/stores/balance-cache.ts:343` | Filter nulls from results array |
| `modules/pioneer/pioneer-cache/src/stores/balance-cache.ts:467` | Filter nulls before return |
| `modules/pioneer/pioneer-cache/src/types.ts` (if exists) | Make `getBatchBalances` return `(BalanceData | null)[]` then filter |
