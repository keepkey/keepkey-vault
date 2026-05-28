# Pioneer Cache: `blockOnMiss: true` Bug

**Status:** Root cause confirmed. One-line fix identified.

---

## The Core Question

> Does Pioneer's portfolio API return 0 immediately from cache when a pubkey is unknown, then sync in the background?

**Answer: NO.** Pioneer blocks the HTTP response on every cache miss and waits for a real on-chain lookup to complete.

---

## Root Cause

**File:** `modules/pioneer/pioneer-cache/src/stores/balance-cache.ts:89`

```typescript
blockOnMiss: true,  // Wait for fresh data on first request - users need real balances!
```

With `blockOnMiss: true`, the execution path for an unknown pubkey is:

```
POST /api/v1/portfolio
  → getBatchBalances(pubkeys, false, false)
    → Redis MGET (fast, <5ms)
    → cache miss detected
    → shouldBlock = this.config.blockOnMiss  // true
    → await Promise.all(fetchPromises)        // BLOCKS HERE
      → fetchFresh() → fetchFromSource()
        → balanceModule.getBalance()          // real on-chain lookup
          → Blockbook (BTC/UTXO) — gap-limit scan, can take 20-60s on cold addresses
          → JSON-RPC (EVM) — one call, usually 2-5s
          → LCD (Cosmos) — one call, usually 3-10s
    → HTTP response finally sent (after all on-chain calls complete or timeout)
```

The background refresh queue (`cache-refresh`) exists and works — but it only activates when `blockOnMiss: false`. With `true`, background refresh is never triggered.

---

## The Fix

**One line change** in `modules/pioneer/pioneer-cache/src/stores/balance-cache.ts:89`:

```typescript
// BEFORE
blockOnMiss: true,   // Wait for fresh data on first request - users need real balances!

// AFTER
blockOnMiss: false,  // Return 0 immediately, queue background refresh for real data
```

### What changes after the fix

| Scenario | Before (blockOnMiss: true) | After (blockOnMiss: false) |
|---|---|---|
| Unknown pubkey, cold cache | Blocks HTTP for 15-60s per chain | Returns `balance: '0'` in <5ms |
| Cache miss | Blocks, awaits on-chain lookup | Queues high-priority job to `cache-refresh` queue |
| Next request (30-60s later) | Cached, fast | Cached (worker populated it) |
| Stale cache (>5 min old) | Returns stale + queues refresh | Same (already correct) |
| `forceRefresh=true` | Bypasses cache, blocks | Bypasses cache, blocks (unchanged) |

### Why `blockOnMiss: false` is correct

1. **Background worker already exists** — `pioneer-cache-worker` processes the `cache-refresh` Redis queue continuously, processing high-priority jobs first.
2. **`triggerAsyncRefresh()` already implemented** — lines 455-460 of balance-cache.ts queue jobs when `!shouldBlock`. The infrastructure is there, just never reached.
3. **Users see 0, then real balances** — on second request (seconds/minutes later), cache is populated. This is standard stale-while-revalidate behavior.
4. **`forceRefresh` still works** — vault can explicitly request blocking fetch when it needs real data immediately (e.g., post-swap).

---

## Core Files

| File | Role | Key Lines |
|---|---|---|
| `modules/pioneer/pioneer-cache/src/stores/balance-cache.ts` | Cache config + `getBatchBalances()` | L89 (`blockOnMiss`), L416 (`shouldBlock`), L418-454 (blocking path), L455-460 (background path) |
| `modules/pioneer/pioneer-cache/src/stores/balance-cache.ts` | `fetchFromSource()` | L133-210 — calls `balanceModule.getBalance()`, real on-chain |
| `modules/pioneer/pioneer-cache/src/core/base-cache.ts` | `fetchFresh()` + `triggerAsyncRefresh()` | L473 (`fetchFresh`), L372 (`triggerAsyncRefresh`) |
| `modules/pioneer/pioneer-cache/src/core/base-cache.ts` | Queue push | L451 — `await this.redisQueue.createWork(this.config.queueName, job)` |
| `services/pioneer-server/src/controllers/balance.controller.ts` | Portfolio endpoint | L426 — `getBatchBalances(normalizedPubkeys, forceRefresh || false, false)` |
| `services/pioneer-cache-worker/src/index.ts` | Background worker | L58-63 — `initializeCacheManager()` with `RefreshWorker` |
| `modules/pioneer/pioneer-cache/src/core/cache-manager.ts` | Worker + queue processing | L266 — `'cache-refresh'` unified queue |

---

## Secondary Config Parameters (for context)

```typescript
// balance-cache.ts defaults
staleThreshold: 5 * 60 * 1000,  // 5 min — triggers background refresh on stale hits
queueName: 'cache-refresh',      // Redis queue for background jobs
enableQueue: true,               // Queue is enabled
apiTimeout: 15000,               // 15s per individual on-chain fetch
maxRetries: 3,
```

With `blockOnMiss: false`:
- Cache miss → `triggerAsyncRefresh(item, 'high')` → `redisQueue.createWork('cache-refresh', job)`
- Worker processes job, fetches on-chain, writes to Redis
- Next HTTP request hits Redis and returns real balance

---

## Vault-Side Context

The vault chunks pubkeys (8 per chunk) with a 20s chunk timeout. With `blockOnMiss: true` and a fresh wallet:
- Each BTC/UTXO pubkey can take 30-60s (gap-limit scan)
- Each chunk of 8 misses blocks for `min(slowest_pubkey, 20s)` → 20s → timeout
- Vault logs: `Portfolio chunk X/Y failed` — silent zero for those chains

After the fix, all chunks return in <100ms. Worker populates cache. Vault retries (or user refreshes) and gets real balances.

---

## Testing

After applying the fix:

1. Clear Redis cache: `redis-cli FLUSHDB` (or restart with fresh Redis)
2. Call `POST /api/v1/portfolio` with a known pubkey
3. Verify response time is <500ms (not 15-60s)
4. Verify `balance: '0'` for unknown pubkeys
5. Wait 30-60s, call again — verify balance is now populated by background worker
6. Check cache-worker logs for `✅ Fetched fresh data` messages

---

## Risk

Low. The comment on line 89 says "Wait for fresh data on first request — users need real balances!" This is a reasonable intent but the wrong mechanism — blocking a 60-pubkey batch request for 60s is not "giving users real balances," it's causing timeouts and showing 0s.

The correct mechanism is what the infrastructure already provides: return 0 fast, populate cache in background, real data appears on next request.
