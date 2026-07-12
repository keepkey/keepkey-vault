# 11 — Rujira THORNode failover

**What:** `intergrations/rujira/src/index.ts` hardcoded a single THORNode host
(`thornode.thorchain.liquify.com`) for FIN contract smart-queries. That host is
dead (connection refused) with no fallback → **every** Rujira FIN quote (RUJI,
TCY swaps) failed. Added the same 2-host failover the main `thorchain`
integration already uses.

**Where:** pioneer `#165` (MERGED) —
`.../projects/pioneer/modules/intergrations/rujira/src/index.ts`
(`THORNODE_HOSTS = [thornode.thorchain.network, rest.cosmos.directory/thorchain]`,
`smartQuery` loops hosts).

## Test
- Needs a pioneer build/deploy with #165 (`make start` in the pioneer monorepo),
  then a RUJI or TCY swap quote through the vault.

## Verify
- [ ] RUJI → (USDC/BTC) and TCY swap **quotes return** (no "Unable to fetch
      pools" / empty quote from the FIN path).
- [ ] Both failover hosts serve the cosmwasm smart-query (verified live this
      session: `thornode.thorchain.network` returns out-of-gas simulate,
      `rest.cosmos.directory/thorchain` returns `{returned,fee}`).

## Status / gotchas
- The "thorchain: Unable to fetch pools" you saw may have been this FIN-path
  failure surfacing under a generic label (prod's main `/thorchain/pools` tested
  healthy). Retry a RUJI swap after the pioneer deploy to confirm.
- Rujira FIN is gated behind `FEATURE_RUJIRA_SWAPS` (api-blue only).
</content>
