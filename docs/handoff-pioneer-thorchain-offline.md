# Handoff: THORChain shows "Offline" in vault swap health — pioneer-side, both THORNode hosts dead

**Date:** 2026-07-02
**Severity:** High — all THORChain swap quotes fail on prod
**Owner:** Pioneer (`pioneer-server` / `@pioneer-platform/thorchain-client`)

## Symptom

Vault Swap dialog shows:

> **THORChain — Offline** — "Pioneer cannot reach this provider. Quotes requiring this route will fail."

## Audit result: NOT a vault bug

The vault banner is a straight relay of pioneer's health endpoint
(`getSwapHealth` in `src/bun/index.ts` → `GET {pioneer}/api/v1/swap/health`).
Prod pioneer itself reports it:

```bash
curl -s https://api.keepkey.info/api/v1/swap/health
# → {"key":"thorchain","label":"THORChain","status":"offline","detail":"fetch failed"}
# (mayachain/shapeshift/relay all "ok")
```

## Root cause

The health check is `thorchain.getMarkets()` →
`pioneer/modules/intergrations/thorchain/src/index.ts` `thornodeFetch()`,
which fails over across exactly two hosts (`THORNODE_HOSTS`, ~line 51).
**Both are currently dead** (verified 2026-07-02):

1. `https://thornode.ninerealms.com` — **DNS record removed.** Cloudflare
   authoritative NS returns NODATA (no A record). All `*.ninerealms.com`
   THORChain hostnames (`thornode`, `midgard`, `rpc`, `thornode-v2`) are gone.
2. `https://thornode.thorchain.liquify.com` — resolves and the node is alive
   (`/thorchain/ping` → `{"ping":"pong"}` with `curl -k`), but it serves a TLS
   cert that **expired 2024-02-07** (`CN=thornode.thorchain.liquify.com`,
   Let's Encrypt R3). `fetch()` rejects → the literal `"fetch failed"` in the
   health detail.

THORChain the network is fine — this is purely dead gateway hostnames.

## Fix (pioneer)

Update `THORNODE_HOSTS` in
`modules/intergrations/thorchain/src/index.ts`. Verified-working THORNode
REST hosts with valid TLS (both serve the two paths the client actually uses,
`/thorchain/pools` and `/cosmos/base/tendermint/v1beta1/blocks/latest`, HTTP 200):

```ts
const THORNODE_HOSTS = [
    'https://thornode.thorchain.network',          // 200 on ping/pools/blocks
    'https://rest.cosmos.directory/thorchain',     // proxy aggregator, 200 on same
];
```

Keep or drop the dead hosts as you like — ninerealms may return (DNS pull could
be an outage on their side), but it must not be the only hope. Liquify is
useless until they renew their cert regardless.

Note: `thornodeFetch` failover only helps when at least one host works; consider
alerting when the health check has been offline > some threshold, since this
was silently red on prod.

## Verify after deploy

```bash
curl -s https://api.keepkey.info/api/v1/swap/health | jq '.integrations[] | select(.key=="thorchain")'
# expect: "status": "ok"
```

Then in vault: Swap dialog → provider health → THORChain shows **Operational**,
and a BTC→RUNE (or any THOR-route) quote returns.

## Dead ends checked (don't retry these)

- `thornode.thorswap.net` → 403 (gated)
- `thorchain-rest.publicnode.com`, `thorchain-node.publicnode.com` → 404 on thornode REST paths
- `midgard.thorchain.network` is healthy (200) but is Midgard, not THORNode — wrong API shape for `getMarkets`/quotes
- `thornode.liquify.com`, `api.thorchain.liquify.com`, `thornode-v1.ninerealms.com` → no DNS
