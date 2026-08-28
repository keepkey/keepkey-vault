# Pioneer handoff: ETH/RUNE degraded balance responses

Date: 2026-08-26
Reporter: KeepKey Vault live dev session
Pioneer base: `https://api.keepkey.info/api/v1`

## Ownership summary

Vault is correctly consuming Pioneer's `PortfolioResponseV2.meta` contract. It
keeps the last known balance when a fresh fetch fails and surfaces degraded or
stale chains instead of presenting an unverified zero. No Vault balance-parser
change is required for this incident.

The remaining failure is Pioneer-side. ETH was transiently degraded but
recovered during isolation. THORChain/RUNE remains reproducibly degraded.

## Live evidence

The original dashboard refresh completed successfully at the HTTP level and
returned 115 portfolio entries, but Pioneer metadata reported:

```text
degraded=[ETH, RUNE]
stale=[RUNE]
```

A subsequent forced, single-chain ETH request recovered:

```text
chain: ETH
balanceRows: 6
meta.degraded: false
meta.failures: []
meta.staleChains: []
meta.serverMs: 1321
traceId: 1b8e025d-c016-4b96-a002-fe4f4ac8f5da
```

A forced, single-chain THORChain request remained broken:

```text
chain: RUNE
balanceRows: 41
meta.degraded: true
meta.degradedCount: 41
meta.failures: 41 entries, each reason="timeout"
meta.staleChains: []
meta.serverMs: 8115
traceId: e0b21b5a-a4cd-40cf-9c05-376903457c74
```

The 41 failures include native RUNE plus every synthetic THORChain denom
expanded for the same owner. This strongly suggests one upstream THORChain
account/provider timeout is being fanned out into an asset-level failure for
every denom.

Pioneer's node diagnostic routes are also broken in production:

```text
GET /api/v1/api/nodes/health
500 this.collection.find(...).toArray is not a function

GET /api/v1/api/nodes/cosmos%3Athorchain-mainnet-v1/all
500 this.collection.find(...).sort is not a function

GET /api/v1/api/nodes/cosmos%3Athorchain-mainnet-v1/best
500 Node type is required
```

The collection-adapter errors may also affect the provider-selection path used
by portfolio balances. Confirm this from server logs before treating it as the
sole root cause.

## Reproduction

Use an existing registered Pioneer query key and any valid THORChain address:

```bash
curl -sS \
  -H "Authorization: $PIONEER_QUERY_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"pubkeys":[{"caip":"cosmos:thorchain-mainnet-v1/slip44:931","pubkey":"<thor-address>"}]}' \
  'https://api.keepkey.info/api/v1/portfolio?forceRefresh=true'
```

Inspect `meta.degraded`, `meta.failures`, `meta.staleChains`, `meta.serverMs`,
and `meta.traceId`. Do not log the authorization key or full wallet address in
the issue or deployment logs.

## Pioneer work

1. Look up trace `e0b21b5a-a4cd-40cf-9c05-376903457c74` and identify the
   selected THORChain provider/node, timeout boundary, and retry count.
2. Repair the node repository/collection adapter used by the health and list
   routes. The production object does not implement the chained Mongo methods
   those controllers expect.
3. Verify whether portfolio provider selection shares that broken adapter.
4. Fetch a THORChain account once per owner/network and fan out successful
   balances locally. Do not execute or report 41 independent upstream timeouts
   for one address.
5. Preserve the last successful chain snapshot on timeout, but report one
   chain-level failure with provider, attempt count, and timeout class in
   structured metadata. Avoid leaking node credentials or wallet identifiers.
6. Add provider failover/circuit-breaker coverage so one dead THORChain node is
   removed from selection before the next dashboard retry.

## Acceptance criteria

- Forced native RUNE portfolio request returns `meta.degraded=false` within the
  normal portfolio SLA.
- Native RUNE is present and reflects the live THORChain account balance.
- One failed upstream account lookup is not multiplied into 41 independent
  network calls/timeouts.
- `/api/nodes/health`, `/api/nodes/:networkId/all`, and
  `/api/nodes/:networkId/best` return 200 for THORChain.
- A deliberately failed primary provider selects a healthy fallback and records
  the provider transition in internal telemetry.
- If every provider fails, Pioneer returns cached data plus explicit structured
  degraded/stale metadata; Vault continues to warn and never presents the
  result as a verified zero.
- Regression test covers ETH healthy + THORChain timeout in the same portfolio
  request, proving the healthy chain remains confirmed.

## Vault verification after Pioneer deploy

1. Refresh the dashboard with `forceRefresh=true`.
2. Confirm the soft-fault banner clears without restarting Vault.
3. Confirm ETH and RUNE rows have `syncState='confirmed'`.
4. Repeat after disabling the primary THORChain provider to validate failover.
