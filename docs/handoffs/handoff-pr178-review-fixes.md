# Handoff: PR #178 Review Fixes — Balance Zero / BTC Send / Timeouts / Audit CAIP

Branch: `swapping-cleanup`  
PR: https://github.com/keepkey/keepkey-vault/pull/178  
Reviewer findings: 2× P1, 2× P2

---

## P1-A: Real zero balances can never replace stale non-zero balances

### What's wrong

`db.ts setCachedBalances` and `updateCachedBalance` use a conditional upsert that only
overwrites stored balance when `balance_usd > 0`:

```sql
balance = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0
          THEN excluded.balance ELSE balance END
```

Same guard is in `Dashboard.tsx` merge:
```typescript
if (!prev || b.balanceUsd > 0 || parseFloat(b.balance || '0') > 0) {
  map.set(b.chainId, b)   // only updates on non-zero
}
```

**Result**: if a user sends all ETH out, Pioneer returns `balance="0", valueUsd=0` on the next
refresh. Both the DB and the UI ignore that zero and keep showing the old balance forever.

### Why the guard was added (context)

The guard was meant to handle a different case: Pioneer's cold-cache or chunk-timeout returning
0 for a chain that still has funds.  That case is already handled upstream — the
`effectivePubkeys` / `results` array in `getBalances` only contains chains from **successful**
chunks. Chains from failed chunks are simply absent from `results`. So by the time `setCachedBalances`
is called, every entry it receives represents a genuinely-returned Pioneer value.

### The fix (two locations)

**`src/bun/db.ts`** — revert to simple unconditional upsert in both `setCachedBalances` and
`updateCachedBalance`. The conditional guard is redundant and harmful here:

```sql
-- Remove the CASE WHEN guards:
ON CONFLICT(device_id, chain_id) DO UPDATE SET
  symbol      = excluded.symbol,
  address     = CASE WHEN excluded.address != '' THEN excluded.address ELSE address END,
  balance     = excluded.balance,
  balance_usd = excluded.balance_usd,
  tokens_json = excluded.tokens_json,
  updated_at  = excluded.updated_at
```

(Keep the `address` guard — an empty string address should not overwrite a real address.)

**`src/mainview/components/Dashboard.tsx:595-606`** — always write chains present in `result`,
only preserve chains **absent** from `result` (those came from failed chunks):

```typescript
// Correct merge: result contains only chains from successful chunks.
// Chains absent from result (failed chunks) stay in map with prior value.
const map = new Map<string, ChainBalance>(balances)
const returnedChains = new Set(result.map(b => b.chainId))
for (const b of result) {
  map.set(b.chainId, b)  // always update — zero here means genuinely zero
}
// Chains not in returnedChains survive in map from the spread above (no action needed)
setBalances(map)
```

### Pioneer API question — does a zero ever mean "stale / unavailable"?

The `GetPortfolioBalances` response has an `isStale` field. Currently the vault ignores it.
If Pioneer can return `balance="0", isStale=true` for a temporarily-unavailable chain, the
simple unconditional write above would still incorrectly zero a real balance.

**Investigation needed before shipping:**
1. Trigger a scenario where Pioneer's data source for one chain is temporarily down.
   Does it return `balance="0", isStale=true` or omit the entry entirely?
2. Trigger a real-zero scenario (fresh wallet or after draining an account).
   Does it return `balance="0", isStale=false`?

**If Pioneer uses `isStale` correctly**, the DB upsert can be:
```sql
balance = CASE WHEN excluded.is_stale = 0 OR CAST(excluded.balance_usd AS REAL) > 0
          THEN excluded.balance ELSE balance END
```
But this requires threading `isStale` through `ChainBalance` → `setCachedBalances` → SQL.

**If Pioneer omits entries for unavailable chains** (rather than returning zero), no Pioneer
changes are needed — the fix above is sufficient.

### Test plan

| Scenario | Expected DB | Expected UI |
|---|---|---|
| Chain queried, Pioneer returns 0, `isStale=false` | Writes 0 | Shows 0 |
| Chain queried, Pioneer returns 0, `isStale=true` | Preserves old | Shows old |
| Chain absent from response (chunk failed) | Preserves old | Shows old |
| Chain present, Pioneer returns real balance | Writes balance | Shows balance |

Use `GET /api/debug/pioneer-audit` to inspect per-chunk Pioneer responses and confirm
`isStale` behavior before deciding on the Pioneer-side contract.

---

## P1-B: BTC send shows aggregate balance but spends only selected xpub

### What's wrong

`AssetPage.tsx:770-775` and `AssetPage.tsx:909-914` both pass `btcAccounts.totalBalance`
(sum across all accounts) into `SendForm` and `SwapDialog`. But:
- `SendForm` passes `xpubOverride={btcSelected?.xpubData?.xpub}` (selected xpub only)
- `index.ts buildTx` builds from that single xpub
- `index.ts getBalance` (singular) also looks up only the selected xpub

So validation MAX and the "balance" label show aggregate BTC (~X.XX), but signing can only
spend the selected xpub's UTXOs.

### The fix

Scope the balance passed to `SendForm` to the selected xpub only. `btcSelected.xpubData`
(`BtcXpub`) already has `.balance: string` and `.balanceUsd: number`:

```typescript
// AssetPage.tsx line 770-775 — SendForm:
balance={isBtc && btcAccounts.accounts.length > 0 ? {
  ...activeBalance!,
  balance: btcSelected?.xpubData?.balance ?? '0',
  balanceUsd: btcSelected?.xpubData?.balanceUsd ?? 0,
  nativeBalanceUsd: btcSelected?.xpubData?.balanceUsd ?? 0,
} : activeBalance}

// AssetPage.tsx line 909-914 — SwapDialog:
balance={isBtc && btcAccounts.accounts.length > 0 ? {
  ...activeBalance!,
  balance: btcSelected?.xpubData?.balance ?? '0',
  balanceUsd: btcSelected?.xpubData?.balanceUsd ?? 0,
  nativeBalanceUsd: btcSelected?.xpubData?.balanceUsd ?? 0,
} : activeBalance}
```

### Longer-term option: multi-xpub spend

If the goal is "spend from all funded xpubs in one send", `buildTx` needs to:
1. Accept multiple xpubs sorted by balance desc
2. UTXO-select across all of them
3. Sign each input group with the correct xpub path

This requires Pioneer or the PSBT builder to support multi-account UTXOs. Defer until
explicitly requested. The fix above is the correct short-term behavior.

---

## P2-A: Backend portfolio timeout exceeds frontend RPC timeout

### What's wrong

- `PIONEER_PORTFOLIO_TOTAL_TIMEOUT_MS = 180_000` (index.ts:131)
- `rpcRequest('getBalances', undefined, 120000)` (Dashboard.tsx:581)

With 90s chunk timeout and concurrency 2: worst case is 180s backend, but frontend cuts
the RPC at 120s and throws "Balance server error" before the backend can return partial results.

### The fix

Increase the frontend RPC timeout to 200s (20s buffer above the 180s backend max):

```typescript
// Dashboard.tsx:581
const result = await rpcRequest<ChainBalance[]>('getBalances', undefined, 200000)
```

Or reduce backend total to 110s (safer, but risks real timeout on slow Pioneer days).
The 200s frontend approach is simpler and avoids changing tuned backend constants.

---

## P2-B: `/api/debug/pioneer-audit` uses `pk.caip` which doesn't exist in `getCachedPubkeys()`

### What's wrong

`getCachedPubkeys()` (`db.ts:1264`) queries:
```sql
SELECT chain_id, path, xpub, address, script_type, balance, balance_usd FROM cached_pubkeys
```

No `caip` column. `rest-api.ts:2830` reads `pk.caip || ''` → always `''` for BTC/non-EVM entries,
making the audit endpoint send empty CAIPs and giving false chunk diagnostics.

### The fix

Build CAIP from `chainId` in the endpoint using a static lookup map:

```typescript
// In /api/debug/pioneer-audit handler, replace the pk.caip reference:
const CHAIN_ID_TO_CAIP: Record<string, string> = {
  bitcoin:   'bip122:000000000019d6689c085ae165831e93/slip44:0',
  dogecoin:  'bip122:00000000001a91e3dace36e2be3bf030/slip44:3',
  litecoin:  'bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2',
  cosmos:    'cosmos:cosmoshub-4/slip44:118',
  thorchain: 'cosmos:thorchain-mainnet-v1/slip44:931',
  mayachain: 'cosmos:mayachain-mainnet-v1/slip44:931',
  osmosis:   'cosmos:osmosis-1/slip44:118',
  ripple:    'ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144',
}

for (const pk of cachedPks) {
  const caip = CHAIN_ID_TO_CAIP[pk.chainId] || ''
  if (pk.xpub) pubkeys.push({ caip, pubkey: pk.xpub, label: `${pk.chainId}:xpub` })
  else if (pk.address) pubkeys.push({ caip, pubkey: pk.address, label: `${pk.chainId}:addr` })
}
```

The EVM section already builds CAIPs correctly from `evmCaips[]` — only the UTXO/Cosmos/XRP
section needed this fix.

---

## File map

| File | Change |
|---|---|
| `src/bun/db.ts:403-412` | Remove conditional balance guards in `setCachedBalances` |
| `src/bun/db.ts:431-440` | Same for `updateCachedBalance` |
| `src/mainview/components/Dashboard.tsx:595-606` | Always-write merge for `result` entries |
| `src/mainview/components/Dashboard.tsx:581` | `120000` → `200000` |
| `src/mainview/components/AssetPage.tsx:770-775` | `totalBalance` → `xpubData.balance` |
| `src/mainview/components/AssetPage.tsx:909-914` | Same for SwapDialog |
| `src/bun/rest-api.ts:2829-2831` | Build CAIP from chainId map, not `pk.caip` |

---

## Pioneer investigation before shipping P1-A

Open questions that determine whether the simple unconditional upsert is safe:

1. **Does Pioneer omit chain entries when a data source is down?**
   Test: kill a chain's RPC behind Pioneer, call `GetPortfolioBalances` for that chain.
   → If entry is omitted: no Pioneer changes needed, simple upsert is correct.
   → If entry is included with `balance="0", isStale=true`: need to thread `isStale` through.

2. **Does `forceRefresh: true` bypass stale-cache and always return fresh data?**
   Currently all vault calls use `forceRefresh: true`. If this guarantees the response
   reflects the latest on-chain state (even if balance=0), then `isStale` can be ignored
   for vault's purposes.

3. **Cold-cache scenario on startup:**
   First call after Pioneer restart — does Pioneer return `isStale=true` with last-known
   balance, or `balance="0"`?  The vault's `setCachedBalances` is the source of truth during
   Pioneer cold start — important to know what Pioneer sends.

Pioneer repo: `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer`  
Relevant endpoint: `GetPortfolioBalances` in pioneer-server  
Look for: `isStale` flag population logic, what happens when a chain's data source is unreachable
