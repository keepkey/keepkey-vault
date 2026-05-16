# Handoff: Pioneer `GET /api/v1/swap/health` Endpoint

**For:** Pioneer server (`services/pioneer-server`)  
**Blocked by this:** Vault swap-page provider status lights  
**Priority:** Medium — UX improvement, no existing endpoint  

---

## What we need

A new endpoint `GET /api/v1/swap/health` that returns the operational status of each swap integration Pioneer supports. The vault uses this to show a row of colored status dots in the swap dialog header so users can see at a glance why a quote is failing (e.g. "THORChain degraded — TRON.TRX pool halted").

---

## Response shape

```ts
interface SwapHealthResponse {
  fetchedAt: number           // Unix ms — client uses this to age the cache
  integrations: IntegrationHealth[]
}

interface IntegrationHealth {
  key: string                 // 'thorchain' | 'mayachain' | 'shapeshift' | 'chainflip'
  label: string               // human-readable: "THORChain", "Mayachain", etc.
  status: 'ok' | 'degraded' | 'offline' | 'unknown'
  haltedPools?: string[]      // CAIP-19s of pools that are staged/suspended (not empty)
  detail?: string             // one-line reason, e.g. "TRON.TRX pool suspended"
}
```

### Example response

```json
{
  "fetchedAt": 1747350000000,
  "integrations": [
    {
      "key": "thorchain",
      "label": "THORChain",
      "status": "degraded",
      "haltedPools": ["tron:0x2b6653dc/slip44:195"],
      "detail": "1 pool suspended: TRON.TRX"
    },
    {
      "key": "mayachain",
      "label": "Mayachain",
      "status": "ok",
      "haltedPools": []
    },
    {
      "key": "shapeshift",
      "label": "ShapeShift",
      "status": "ok"
    },
    {
      "key": "chainflip",
      "label": "Chainflip",
      "status": "ok"
    }
  ]
}
```

---

## How to derive status

### THORChain
The `swap-config.controller.ts` already calls `thorchain.getMarkets()` which returns an array of pools, each with `pool.status`.

```
pool.status === 'Available' → that pool is tradeable
pool.status === 'Staged'    → depositable but not yet tradeable
pool.status === 'Suspended' → halted
```

Derivation logic:
- If `thorchain.getMarkets()` throws/returns non-200 → `status: 'offline'`
- If any pool is `Suspended` → `status: 'degraded'`, list the suspended asset strings in `haltedPools`
- Otherwise → `status: 'ok'`

### Mayachain
Same pattern — `mayachain.getMarkets()` returns pools with `status`.

### ShapeShift / Relay
ShapeShift is an aggregator routed through Pioneer's quote path. Use a lightweight probe: attempt to quote a known-liquid pair (e.g. ETH → BTC, 0.01 ETH) via the ShapeShift integration specifically, and record success/failure. Cache the result for 60s.

Alternatively, if ShapeShift exposes a status page API, use that.

For an initial simple version: if Pioneer itself is responding (we're handling this request), ShapeShift can be assumed `ok` unless a recent quote threw a non-recoverable error. Track quote failures per integration in a small in-memory map (TTL 5 min).

### Chainflip
Same lightweight probe approach as ShapeShift. Chainflip has a public RPC: if `https://mainnet-archive.chainflip.io` responds, it's up. Cache for 60s.

---

## Caching

Do **not** call THORNode/Maya on every request — that's expensive. Use the same pool data that `getMarkets()` already fetches and caches. Suggested TTL: 30 seconds.

The endpoint should return immediately from cache if the data is fresh, and trigger a background refresh if stale.

```
Cache key: 'swap:health'
TTL: 30s (or piggyback on getMarkets cache)
```

---

## Where to add it

**Controller:** `src/controllers/swap-config.controller.ts` — new method `getSwapHealth()`, decorated `@Get('/health')` under `@Route('api/v1/swap')`.

**Route registration:** Add to `src/routes.ts` following the same TSOA pattern as the other swap-config endpoints.

---

## What the vault does with this

The vault calls `getSwapHealth` once when the swap dialog opens and again every 60 seconds. It maps the response to three-color dots (green/amber/red) shown in the swap header next to each provider logo. When a quote fails with "pool halted / unavailable", the UI can cross-reference `haltedPools` to surface a specific message instead of a generic error.

The vault already has `ProviderBadge.tsx` with icons for all four integrations (THORChain, Mayachain, ShapeShift, Chainflip). The new dots sit beside those.

---

## Out of scope for Pioneer

The vault side (RPC method + UI dots) is blocked on this endpoint existing. Once Pioneer ships it, the vault implementation is a few-hour task:
- New RPC `getSwapHealth` that fetches this endpoint
- `ProviderHealthBar` component (row of 4 dots + labels)
- Mount in SwapDialog header, poll every 60s
