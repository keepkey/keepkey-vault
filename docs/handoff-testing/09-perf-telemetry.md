# 09 — Vault↔API perf telemetry

**What:** split perceived-slow portfolio loads into API vs network/client time.
Server stamps `serverMs`/`traceId` on `POST /portfolio` and exposes
`POST /api/v1/telemetry/vault`; the vault times every `GetPortfolioBalances`
(wrapped once on the pioneer client singleton) and posts
`{traceId, serverMs, clientTotalMs, outcome, …}`; backend computes
`networkMs = clientTotalMs − serverMs`.

**Where:**
- pioneer `#164` (MERGED) — server stamp + ingest.
- vault `#334` (MERGED, develop) —
  `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/perf-telemetry.ts`
  + `pioneer.ts` hook; tests `__tests__/perf-telemetry.test.ts`.

## Test
- Unit: `cd .../projects/keepkey-vault && bun test __tests__/perf-telemetry.test.ts` (11/11).
- Data-flow: run a Vault build with #334 against a pioneer that has #164 deployed
  with the `/api/v1/telemetry/vault` route live; load a portfolio a few times.

## Verify
- [ ] Records batch + flush to `POST /api/v1/telemetry/vault` (fire-and-forget —
      a failed flush must never block/error a load).
- [ ] Backend joins on `traceId` and reports `networkMs`/`serverMs` split.
- [ ] Outcome classification: ok / slow (>3s) / degraded / timeout / error.
- [ ] `appVersion` matches the shipped build; endpoint no-ops gracefully until
      the pioneer ingest is deployed.

## Status / gotchas
- Both halves merged; the **pioneer prod deploy of the ingest endpoint** + a
  dashboard read endpoint are the remaining pieces.
</content>
