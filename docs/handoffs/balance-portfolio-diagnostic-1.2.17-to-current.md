# Balance & Portfolio Diagnostic: v1.2.17 → current

**Branch:** `swapping-cleanup`  
**Symptom:** Fresh wallet shows 0 balances across all chains  
**Date:** 2026-05-17

---

## Executive Summary

Five distinct changes since 1.2.17 can each independently produce 0 balances on a fresh wallet.
The most critical is the **error handling inversion** (`efadfdb5`) — what used to silently fall back
to showing 0s now throws and surfaces a Pioneer error banner. Combined with the new chunked Pioneer
call architecture, a single network hiccup during the cold-start Pioneer call drops the entire
refresh cycle and leaves the UI in an error state with no balance data.

---

## Change Index (chronological, balance-relevant only)

| Commit | Description |
|--------|-------------|
| `efadfdb5` | **Stabilize balances and swap pricing** — silent 0-fallback replaced with hard throw |
| `01c86844` | **Switch EVM asset balances by address** — `updateAddressBalance` → `setAddressChainBalance` + `recalculateBalanceUsd` |
| `f5880924` | **Improve Windows Pioneer balance refresh** — sequential chunking introduced (8 pubkeys/chunk, 20s each) |
| `1fdbd581` | **Balance refresh fallback handling** — skip zeroing chains from failed chunks; partial > nothing |
| `232d81d9` | **Fix incomplete portfolio refresh handling** — sequential loop → concurrent `mapWithConcurrency` (4 parallel) + 45s total timeout |
| `74120bd6` | **Portfolio debug, token dedup** — total timeout 90s; `seenByOwnerCaip` dedup; `evmTokensByOwner` dedup |
| `7708deee` | **Sync BTC DB cache with aggregate total** — `updateCachedBalance(bitcoin)` after every `btc-accounts-update` |
| `b11b63e9` | **Fix dashboard token warning for empty wallets** — removed the token-warning banner (was a diagnostic signal) |

---

## Change 1: Silent fallback → hard throw (`efadfdb5`)

### Before (1.2.17)

```typescript
} catch (e: any) {
    console.warn('[getBalances] Portfolio API failed:', e.message)
    const seen = new Set<string>()
    for (const entry of pubkeys) {
        if (seen.has(entry.chainId)) continue
        seen.add(entry.chainId)
        results.push({ chainId: entry.chainId, symbol: entry.symbol, balance: '0', balanceUsd: 0, address: entry.pubkey })
    }
}
```

On Pioneer failure, the old code returned 0-balance entries for every chain. The UI loaded
normally and showed zero. No error banner, no indication anything failed.

### After (current)

```typescript
} catch (e: any) {
    const message = getPioneerPortfolioErrorMessage(e)
    console.warn('[getBalances] Portfolio API failed:', message)
    try { rpc.send['pioneer-error']({ message, url: getPioneerApiBase() }) } catch {}
    throw new Error(`Balance server error: ${message}`)
}
```

On Pioneer failure, the RPC handler now throws. The `getBalances` RPC call rejects.
Dashboard catches it and shows the Pioneer error banner with a "change server" prompt.

**Fresh wallet impact:** A fresh wallet has cold Pioneer cache (never looked up these addresses).
Pioneer may be slow or time out on first lookup. Under the old code this returned 0s silently.
Under the new code this surfaces as an error — which is correct behavior, but means users
see an error instead of "loading" on first launch.

---

## Change 2: Single API call → chunked parallel calls (`f5880924`, `232d81d9`, `74120bd6`)

### Before (1.2.17)

```typescript
const resp = await withTimeout(
    pioneer.GetPortfolioBalances(
        { pubkeys: pubkeys.map(p => ({ caip: p.caip, pubkey: p.pubkey })) },
        { forceRefresh: true }
    ),
    PIONEER_TIMEOUT_MS,  // 60,000ms
    'GetPortfolioBalances'
)
```

One call, all pubkeys (typically 30–50 depending on chains), 60s total timeout.

### After (current)

```typescript
const PIONEER_PORTFOLIO_CHUNK_SIZE = 8
const PIONEER_PORTFOLIO_CHUNK_TIMEOUT_MS = 20_000
const PIONEER_PORTFOLIO_MAX_CONCURRENCY = 4
const PIONEER_PORTFOLIO_TOTAL_TIMEOUT_MS = 90_000

const pubkeyChunks = chunkArray(pubkeys, PIONEER_PORTFOLIO_CHUNK_SIZE)
const chunkResults = await withTimeout(
    mapWithConcurrency(pubkeyChunks, PIONEER_PORTFOLIO_MAX_CONCURRENCY, async (chunk, i) => {
        // ... each chunk: 20s timeout, retry without extraContracts on schema error
        return { entries: [...], error: null }  // or { entries: [], error: 'msg' }
    }),
    PIONEER_PORTFOLIO_TOTAL_TIMEOUT_MS,  // 90s outer
    'GetPortfolioBalances chunks'
)
```

30–50 pubkeys → 4–7 chunks, up to 4 running in parallel, 20s per chunk, 90s outer wall clock.

**Fresh wallet impact (critical path):**
1. A fresh wallet sends all pubkeys to Pioneer for the first time (cold cache).
2. Pioneer must index/scan all addresses — can be slow (15–25s per chain on first hit).
3. If any chunk hits the 20s per-chunk timeout, that chunk's chains show 0.
4. If ALL chunks fail (Pioneer down / network timeout), the outer throw fires → error banner → 0 balances.
5. Partial failure (some chunks succeed, some fail): those chains show 0 but no error is surfaced
   (only a console warning), so users see mixed balances with no explanation.

**What triggers "all 0":** total Pioneer timeout (outer 90s), or Pioneer completely unreachable.
**What triggers "partial 0":** individual chunk timeouts (20s), or chunk-level 4xx/5xx from Pioneer.

---

## Change 3: EVM balance aggregation rewrite (`01c86844`)

### Before (1.2.17)

```typescript
if (usd > 0) evmAddresses.updateAddressBalance(entry.pubkey, usd)
// evmChainAgg.set(chainId, { balance, usd, address, symbol })
```

`updateAddressBalance` added `usd` directly to `EvmTrackedAddress.balanceUsd`.

### After (current)

```typescript
const entryTokens = evmTokensByOwner.get(`${entry.chainId}:${entry.pubkey.toLowerCase()}`) || []
const entryTokenUsd = entryTokens.reduce((sum, t) => sum + t.balanceUsd, 0)
evmAddresses.setAddressChainBalance(entry.pubkey, entry.chainId, {
    balance: bal > 0 ? bal.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') : '0',
    balanceUsd: usd + entryTokenUsd,
    nativeBalanceUsd: usd,
})
// recalculateBalanceUsd sums address.chainBalances[*].balanceUsd
```

Each address now stores per-chain balances in `chainBalances: Record<chainId, EvmAddressChainBalance>`.
`recalculateBalanceUsd()` sums all chain balances to get `address.balanceUsd`.

**Fresh wallet impact:**
- Before: if Pioneer returned any usd > 0, it was added immediately.
- After: if Pioneer returns 0 for a chain (fresh wallet, unindexed), `chainBalances[chainId].balanceUsd = 0`.
  `recalculateBalanceUsd` sums zero → `address.balanceUsd = 0`. The address shows 0.
- This is correct behavior, not a regression — but the chain/token UI in AssetPage now
  depends on `evmTokensByOwner` being populated. If it isn't (fresh wallet, no tokens), the
  per-address token view is empty.

**resetBalances change:**

```typescript
// Before
resetBalances(): void { for (const a of this.addresses) a.balanceUsd = 0 }

// After — accepts chainId to reset one chain before single-chain refresh
resetBalances(chainId?: string): void {
    for (const a of this.addresses) {
        if (chainId) {
            if (a.chainBalances) delete a.chainBalances[chainId]
            this.recalculateBalanceUsd(a)
        } else {
            a.balanceUsd = 0
            a.chainBalances = {}
        }
    }
}
```

On full `getBalances`, `resetBalances()` (no chainId) zeroes everything.
On single-chain `getBalance`, `resetBalances(chain.id)` only removes that chain —
preserving other chains' contributions to the address USD total.

---

## Change 4: Cache write guard change (`1fdbd581` → `232d81d9` → `74120bd6`)

### 1.2.17

```typescript
if (results.length > 0 && !engine.isPassphraseWallet) setCachedBalances(deviceId, results)
```

### After `1fdbd581` (interim)

```typescript
// Only skip cache on partial/chunk failures — was blocking cache writes on any failure
```

### Final state (current)

```typescript
// Cache balances (fire-and-forget).
// Write partial results even on chunk failures — chains from failed chunks simply
// won't be in results, so the next getCachedBalances staleness check will flag
// them as missing and trigger another refresh. Partial is always better than nothing.
if (results.length > 0 && !engine.isPassphraseWallet) setCachedBalances(deviceId, results)
```

**Fresh wallet impact:** On the very first successful balance fetch, the cache is written.
On total failure (throw), the cache is never written. On partial failure (some chunks failed),
the partial results ARE written. Next refresh will re-fetch the missing chains.

---

## Change 5: BTC DB cache sync (`7708deee`)

### Problem

`getCachedBalances(deviceId)` was returning the last single-xpub Bitcoin value rather than
the multi-account aggregate. SwapDialog and REST endpoints that read from cache saw stale BTC.

### Fix

After every `btc-accounts-update` push (both in `getBalances` and `getBalance`), now also
calls `updateCachedBalance(devId, { chainId: 'bitcoin', balance: totalBalance, ... })`.

```typescript
const btcSet = btcAccounts.toAccountSet()
try { rpc.send['btc-accounts-update'](btcSet) } catch {}
// NEW: sync DB cache
updateCachedBalance(devId, {
    chainId: 'bitcoin', symbol: 'BTC',
    balance: btcSet.totalBalance,
    balanceUsd: btcSet.totalBalanceUsd,
    nativeBalanceUsd: btcSet.totalBalanceUsd,
    address: btcAccounts.getSelectedXpub()?.xpub || '',
})
```

**Fresh wallet impact:** Fresh wallet → BTC account manager just initialized → `totalBalance = '0'` →
`updateCachedBalance` writes 0 to DB. This is correct, not a regression.

---

## Diagnostic Checklist for "0 Balances on Fresh Wallet"

Run with vault console open. Look for these log lines:

### Step 1: Did Pioneer initialize?

```
[getBalances] Pioneer init failed (will return zero balances): <msg>
```

If this appears → Pioneer URL is unreachable or auth failed. Check Pioneer server URL in
Settings → Advanced → Pioneer Servers.

```
[getBalances] <N> pubkeys (<M> BTC xpubs) → chunked GetPortfolioBalances calls
```

N should be > 20 (all chains). M should be ≥ 1 (at least one BTC xpub). If M = 0, BTC
account manager failed to initialize. If N < 15, some chain derivation failed.

### Step 2: Did chunks succeed?

```
[getBalances] Portfolio chunk X/Y failed (caip1, caip2): <error>
```

Each line = one chunk of 8 chains that timed out or got an API error.
If you see this for all chunks → Pioneer is down or addresses have no cached data yet.

```
[getBalances] Partial portfolio response: X/Y chunks succeeded — failed chains will show 0
```

Partial success. Failed chains will be missing from results.

```
[getBalances] All Y portfolio chunks failed
```

Total failure → error thrown → Pioneer error banner shown → 0 balances.

### Step 3: Did entries come back?

```
[getBalances] GetPortfolioBalances response: <N> entries
[getBalances] After classification: <X> natives, <Y> tokens
```

N = 0 on a fresh wallet with no Pioneer cache yet. This is expected on first launch —
Pioneer must index the addresses before it can return balances.

### Step 4: Did the cache write succeed?

```
[getBalances] FINAL: <N> chains, <M> tokens, $<USD>
```

If USD = 0 but you have funds, the balance server did not return your data. Try:
1. Wait 30–60s and hit refresh (Pioneer may be warming up cache for new addresses).
2. Change Pioneer server to a different endpoint.
3. Check whether the device ID / seed changed (factory reset clears cached pubkeys).

---

## Root Cause Assessment: Fresh Wallet Shows 0

The most likely cause is **Pioneer cold-cache + per-chunk timeout**:

1. Fresh wallet → addresses never seen by Pioneer.
2. Pioneer must scan on-chain for each address (Ethereum, Cosmos, BTC gap-limit scan, etc.).
3. This takes 10–30s per address on first lookup.
4. With `PIONEER_PORTFOLIO_CHUNK_TIMEOUT_MS = 20_000` (20s), Pioneer can't finish
   scanning a brand-new BTC address (gap-limit scan) in time.
5. Chunk fails → chains in that chunk show 0 → no error surfaced to user → silent zeros.

**In 1.2.17**, the same cold-start took up to 60s (single call) but was more likely to complete
because Pioneer could process all pubkeys at once and return partial results in one response.
Under chunking, a 20s timeout per chunk is much tighter than a 60s timeout for everything.

**Fix candidates:**
- Increase `PIONEER_PORTFOLIO_CHUNK_TIMEOUT_MS` to 45_000 (match original 60s / ~1.3 chunks).
- Add a "first refresh" path that disables chunking and uses the original single-call with 60s.
- Show a "scanning new wallet..." banner when `allEntries.length === 0` after a successful call.

---

## Files Changed (Balance/Portfolio Surface Area)

| File | Lines changed | Role |
|------|--------------|------|
| `src/bun/index.ts` | ~1,100 | `getBalances` + `getBalance` RPC handlers, all Pioneer calls |
| `src/bun/evm-addresses.ts` | ~40 | `setAddressChainBalance`, `recalculateBalanceUsd`, `resetBalances(chainId)` |
| `src/bun/db.ts` | ~360 | `updateCachedBalance` (BTC aggregate sync), API log scoping |
| `src/mainview/components/Dashboard.tsx` | ~80 | Removed token-warning banner; `hasEverRefreshed` state |
