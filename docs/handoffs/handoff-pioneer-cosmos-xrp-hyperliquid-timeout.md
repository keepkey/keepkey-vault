# Handoff: Pioneer — Cosmos / XRP / Hyperliquid GetPortfolioBalances timeout

Repo: `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer`
Related vault PR: https://github.com/keepkey/keepkey-vault/pull/178
Priority: P1 — cosmos, thorchain, maya, osmosis, xrp, hyperliquid all show $0 on every load

---

## Observed symptom (vault side)

Vault builds pubkeys in this order: UTXO → EVM → nonEVM (cosmos/xrp) → BTC.
With chunk size 8 and 10 EVM chains, chunk 3 looks like:

```
[eip155:2868/slip44:60  : 0xETH]   ← Hyperliquid
[cosmos:cosmoshub-4/...  : cosmos1...]
[cosmos:thorchain-mainnet-v1/... : thor1...]
[cosmos:mayachain-mainnet-v1/... : maya1...]
[cosmos:osmosis-1/...   : osmo1...]
[ripple:4109c.../...    : rXXX...]
[BTC xpub1]
[BTC xpub2]
```

This chunk times out at 45 s on every load. The vault log confirms:

```
[getBalances] Partial portfolio response: 2/3 chunks succeeded — failed chains will show 0
[getBalances] Chunk 3 failed — excluded chains: hyperliquid, cosmos, thorchain, mayachain, osmosis, ripple, bitcoin, bitcoin
```

The result: all 6 chains appear with balance=0 in the vault (vault-side workaround
in PR #178 ensures they at least show up rather than vanishing, but balance is always 0).

---

## Root cause hypothesis

Pioneer's `GetPortfolioBalances` handler is slow or erroring for one or more of these CAIPs:

| Chain | CAIP sent to Pioneer |
|---|---|
| Hyperliquid | `eip155:2868/slip44:60` |
| Cosmos | `cosmos:cosmoshub-4/slip44:118` |
| THORChain | `cosmos:thorchain-mainnet-v1/slip44:931` |
| Mayachain | `cosmos:mayachain-mainnet-v1/slip44:931` |
| Osmosis | `cosmos:osmosis-1/slip44:118` |
| XRP | `ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144` |

**Most likely culprits:**

1. **Hyperliquid (`eip155:2868`)** — new chain, Pioneer may not have a registered RPC or
   balance fetcher for it. A single unknown CAIP can cause the entire batch to hang if
   Pioneer awaits a fetch that never returns.

2. **Cosmos-family chains** — `pioneer-cache` fetches via external RPCs
   (`api.cosmos.shapeshift.com`, `lcd-osmosis.keplr.app`, `thornode.ninerealms.com`).
   These endpoints may be slow, rate-limited, or stale since the ninerealms migration.
   See also: `handoff-pioneer-fetch-error-zero.md` — failed fetches silently return `balance:'0'`
   instead of propagating the error.

3. **XRP** — `xrplcluster.com` may be timing out.

---

## How to diagnose

### 1. Call GetPortfolioBalances directly

```bash
curl -X POST https://api.keepkey.info/portfolio \
  -H "Content-Type: application/json" \
  -H "Authorization: key:public-test" \
  -d '{
    "pubkeys": [
      { "caip": "cosmos:cosmoshub-4/slip44:118", "pubkey": "cosmos1YOURADDRESS" },
      { "caip": "cosmos:thorchain-mainnet-v1/slip44:931", "pubkey": "thor1YOURADDRESS" },
      { "caip": "cosmos:osmosis-1/slip44:118", "pubkey": "osmo1YOURADDRESS" },
      { "caip": "ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144", "pubkey": "rXXX" },
      { "caip": "eip155:2868/slip44:60", "pubkey": "0xETH" }
    ]
  }' \
  --max-time 60
```

Time the response. If it exceeds 10s, the culprit RPC is slow. If it errors immediately,
the CAIP is unregistered.

### 2. Bisect — send each chain individually

Send each pubkey as a single-element batch and time each separately. The one that
hangs or errors is the culprit poisoning the whole chunk.

### 3. Check pioneer-cache logs

In the pioneer repo, `pioneer-cache/src/stores/balance-cache.ts` logs warn-level
messages when `fetchFresh` fails. Run with `DEBUG=true` and watch for which chain
blocks.

---

## Fixes needed in Pioneer

### A. Hyperliquid — register or no-op

If `eip155:2868` has no registered balance fetcher in pioneer-cache, `fetchFresh`
likely returns null/undefined → the `getBatchBalances` catch block returns `{balance:'0'}`
(see `handoff-pioneer-fetch-error-zero.md`).

**Fix options:**
- Add an EVM RPC for Hyperliquid and register it in the chain config
- OR explicitly return `null` for unregistered chains so the vault omits them cleanly

### B. Cosmos-family RPC health

Check `pioneer-cache/src/stores/balance-cache.ts` and the RPCUrl config:

```
RPCUrl["Cosmos"] = "https://api.cosmos.shapeshift.com"   ← may be down
RPCUrl["Osmosis"] = "https://lcd-osmosis.keplr.app"
RPCUrl["THORChain"] = "https://thornode.ninerealms.com"  ← ninerealms migration risk
RPCUrl["Mayachain"] = "https://mayanode.mayachain.info"
RPCUrl["Ripple"] = "https://xrplcluster.com"
```

Verify each is reachable and returns in <5s. Replace dead/slow ones with working mirrors.

### C. Per-CAIP timeout in getBatchBalances

Currently one slow CAIP blocks the entire batch. Add a per-entry timeout inside
`getBatchBalances` so a single hanging RPC only zeroes that chain, not the whole chunk:

```typescript
const balanceInfo = await Promise.race([
    fetchFresh(item),
    new Promise((_, reject) => setTimeout(() => reject(new Error('per-entry timeout')), 10_000))
])
```

### D. Return null on failure (from existing handoff)

`handoff-pioneer-fetch-error-zero.md` covers this in detail. The same catch blocks that
return `{balance:'0'}` on RPC failure should return `null` so the vault knows the entry
was an RPC error vs a genuine zero balance. This is complementary to fix C.

---

## Files

| File | Change |
|---|---|
| `pioneer-cache/src/stores/balance-cache.ts` | Per-entry timeout in getBatchBalances; return null on failure |
| `pioneer-cache/src/config/chains.ts` (or equivalent) | Fix/replace dead Cosmos/XRP RPC URLs |
| Chain registry | Register Hyperliquid (eip155:2868) or return null for unknown CAIPs |

---

## Test plan

After fixes, call `GetPortfolioBalances` with the 6-chain batch above and verify:
- Response time < 10s
- All 6 chains return a non-null balance entry (or null if no data, not a 60s hang)
- Vault FINAL count = 23 chains, none of the 6 showing 0 due to timeout
