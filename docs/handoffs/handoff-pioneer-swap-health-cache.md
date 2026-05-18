# Handoff: Pioneer — Cache Swap Health in Redis

**Date**: 2026-05-17  
**Priority**: Medium — causes vault swap UI to show all providers "offline" when endpoint hangs

---

## Problem

`GET /api/v1/swap/health` makes live requests to THORNode, Mayachain, ShapeShift, Relay on **every call**.

- THORNode is flaky — when it hangs (no response), the whole health endpoint hangs with it
- Vault calls this endpoint every 60s (SwapDialog open) with an 8s client timeout
- When Pioneer hangs > 8s, vault falls back to showing all providers as "offline" — false negative

Observed: endpoint returns in < 1s when THORNode responds, times out at 15s when it doesn't.

---

## Fix: Redis-cached background poller

### Pattern
```
Background job (every 30s):
  → hit THORNode, Mayachain, ShapeShift, Relay in parallel (each with 10s timeout)
  → write result to Redis: SET swap:health <json> EX 120
  
GET /api/v1/swap/health:
  → read from Redis (instant)
  → if key missing (cold start): return { status: 'unknown' } for each integration
  → never make live external requests inline
```

### Redis key
```
swap:health
```

### Response shape (no change needed)
```json
{
  "fetchedAt": 1779018528488,
  "integrations": [
    { "key": "thorchain",  "label": "THORChain",  "status": "ok" | "degraded" | "offline" | "unknown" },
    { "key": "mayachain",  "label": "Mayachain",  "status": "ok" },
    { "key": "shapeshift", "label": "ShapeShift", "status": "ok" },
    { "key": "relay",      "label": "Relay",      "status": "ok" },
    { "key": "chainflip",  "label": "Chainflip",  "status": "ok" }
  ]
}
```

`"unknown"` is a valid status (already in vault's `SwapProviderStatus` type) — use it on cold start or when a check is still pending.

### Background job behavior
- Run immediately on server start, then every 30s
- Each integration check: 10s timeout, catch → `{ status: 'offline', detail: <error> }`
- Write the full payload to Redis with TTL 120s (so stale data auto-expires if poller dies)
- Log a warning if any check exceeds 5s (early warning for THORNode issues)

---

## Vault-side (no change needed)

Vault already handles the `'unknown'` status correctly in the UI. Once Pioneer returns fast, the 8s client timeout stops firing. No vault changes required.

---

## Why This Matters

Every open SwapDialog polls every 60s. With multiple users, Pioneer's health endpoint was being called constantly and making N×(integrations) outbound requests per second. Redis caching means:
- Response time: 1-2ms (Redis read) instead of 1-15s (live check)
- External load: 1 check per integration per 30s regardless of how many clients are polling
- No false "offline" banners when THORNode is just slow

---

## Files to Change in Pioneer

Look for the existing health handler — likely in:
- `src/routes/swap.ts` or `src/controllers/swap-health.ts`
- The current handler that makes live THORNode/etc requests

Add a background scheduler (Bull, node-cron, or setInterval at startup) that does the polling and writes to Redis. The route handler becomes a simple Redis `GET`.
