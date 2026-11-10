# Provider usage incident retrospective November 2026

The Zerion gateway used a paid wallet-data API as a recurring transaction
notification feed. The intended policy was to load wallet data on opening and
on explicit user refresh. Monitoring continued independently of that lifecycle,
bypassed caching and duplicated wallet-wide reads across chain groups. This was
a preventable design and release-control failure. Credential rotation contained
use of the old key; removing recurring reads addressed the server cost mechanism.
Desktop enforcement is implemented in commit `29c0ace72`; it takes effect for users when the next Vault binary is released.

The reported impact is approximately 70 percent of a monthly Zerion allowance
consumed in one week. The supplied dashboard shows a sharp early-November spike.
Historical billing reconciliation was explicitly removed from scope by the owner: the objective is efficient necessary usage, with more capacity purchased when needed. Do not present cache writes, request counts
or theoretical rates as billed credits or dollars.

## Which provider ran where

| Deployment | Provider behavior | Current state |
| --- | --- | --- |
| `api.keepkey.info`, DigitalOcean Pioneer 1.4.7 | Zapper supplies broad EVM token/portfolio discovery alongside existing chain/RPC sources and cache fallbacks. | Zapper remains configured, with cache-only refresh policy and failure backoff deployed to all three replicas. Canary upstream reads still returned 525; process health does not establish provider recovery. |
| `oracles.cc` and `api-blue.keepkey.info`, Cloudflare gateway | Zerion supplies EVM positions, DeFi positions and transaction history. NOWNodes supplies separate chain/RPC data. | Recurring Zerion reads are disabled. Explicit HTTP portfolio/history reads remain available. |

The gateway implements a different provider stack; production `.info` has not
been cut over to it. There is no new Zapper-to-Zerion fallback installed on the
DigitalOcean service as part of this response. The no-polling fix does not replace
Zerion with another paid polling provider. EVM payment discovery now needs a push
source if automatic notifications are required; existing UTXO monitoring continues.

Zapper calls on `.info` come from portfolio enrichment. A forced portfolio request
fetches Zapper immediately. An ordinary request can queue a cache refresh when
Zapper data is missing or near expiry. Source defaults are a five-minute token
cache and a one-minute refresh cooldown; runtime overrides can change them.
Desktop refreshes can repeatedly enter this path. This is separate from the
gateway's 15-second Zerion history loops and does not explain Zerion billing.

## Timeline in UTC

| Time | Change or observation |
| --- | --- |
| October 29 19:31 | Gateway wallet-core commit introduced Zerion integration and active history fallback polling. That version used a 30-second base cadence, quiet-period backoff and normal cache behavior. This is the commit time, not a verified production deployment time. |
| November 3 22:41 | [Gateway PR 10](https://github.com/BitHighlander/keepkey-gateway/pull/10) merged live-payment and durable offline replay. Active polling became a fixed 15 seconds with forced history refreshes; durable alarms also ran every 15 seconds after clients disconnected. |
| Early November | Provider dashboard usage rose sharply. The timing is consistent with the monitoring changes, but does not attribute every historical billed request. |
| November 9 | Inventory found 72 enabled EVM registrations, five distinct addresses, nine chains and one client. Transaction-cache versions were approximately 222,000. Cache versions corroborate repeated history work but are not a billing counter. |
| November 9 18:53 | [Gateway PR 13](https://github.com/BitHighlander/keepkey-gateway/pull/13) merged per-wallet batching and durable usage metrics. This reduced duplication but retained recurring paid polling. |
| November 9 to 10 | DigitalOcean production received [Pioneer PR 220](https://github.com/coinmastersguild/pioneer/pull/220), version 1.4.6, adding independent Mongo provider counters on all three replicas. This was an observability deployment, not a Zapper replacement. |
| November 10 03:20 to 03:27 | Replacement Zerion credential was installed, the gateway restarted, and explicit history reads verified. After user revocation, the old credential returned 401 and the replacement returned 200. |
| November 10 05:14 | [Gateway PR 15](https://github.com/BitHighlander/keepkey-gateway/pull/15) merged removal of recurring Zerion reads. |
| November 10 05:16 | [Gateway deployment](https://github.com/BitHighlander/keepkey-gateway/actions/runs/42760919030) completed successfully. Both gateway hosts served revision `668b52c0f705461210e3bd52359f6c762d101766`. |
| After deployment | A temporary EVM durable watch and SSE subscription remained connected for 35 seconds, spanning two former polling intervals. Durable counters showed zero additional recurring Zerion attempts. An explicit fresh history request returned 200; the temporary watch was removed. |

## Root cause and amplification

Transaction notification freshness was implemented by repeatedly requesting full
wallet history from Zerion. Saved registrations outlived the Vault session, so
closing the wallet did not end durable monitoring. The implementation treated
notification delivery and paid wallet-data refreshes as the same operation.

`forceRefresh: true` bypassed the normal history cache on every tick. The durable
monitor grouped registrations by network and address, although Zerion history was
already wallet-wide across chains. In-flight coalescing only joined overlapping
calls; another chain group or later tick could make another paid fetch after the
first completed. Connected-client polling ran separately from durable monitoring.

For a continuous-running model, five addresses at one fetch every 15 seconds
would generate 28,800 calls per day even after batching. Up to 45 address/chain
groups could generate 259,200 calls per day before coalescing, delays and errors.
These calculations explain the exposure; they are not reconstructed bill totals.
No shared provider budget in the inspected request path bounded this behavior.

## Why it escaped review

- The acceptance criteria covered transaction delivery and offline replay, not
  provider calls per wallet opening, per closed session or per day.
- Tests encoded the expensive behavior: EVM monitoring tests expected another
  fresh fetch on the next tick. More tests of that contract would not have fixed
  the product-policy error.
- Forced refresh was a general mechanism rather than a permission tied to a
  wallet-open or explicit-user refresh reason.
- Cache reuse and concurrency limits were treated as cost controls. Neither
  limits total spend from sequential requests over hours or days.
- Durable registrations had no session-scoped lifetime or paid-provider budget
  preventing indefinite background reads.
- The gateway had no physical upstream counters when the feature shipped, and
  the feature tests did not validate a quota alert or a calls-per-session limit.
  Gateway counters began on November 9 and cannot reconstruct earlier calls.
- One credential was reused across environments, complicating attribution. The
  old key was also configured on an unrelated DigitalOcean inference deployment;
  inspected source there showed no Zerion calls. That is not evidence that it
  generated the billed traffic.

The evidence establishes internal amplification. It does not establish credential
theft, an incoming DDoS or complete attribution of the provider dashboard spike.

## Response mistakes and accountability

In this session, I initially shipped per-wallet batching before confirming the
intended paid-provider policy. That left the recurring-spend risk in place. The
correct first question was whether background Zerion polling should exist at all.
The subsequent no-polling change addressed that policy directly.

The response also needed clearer separation of service health, provider health
and deployment targets. A healthy `.info` process could still receive Zapper 525s;
a healthy gateway could still consume an excessive quota. Broad statements such
as "production is healthy" or "the fix is deployed" must identify the host and
the behavior actually verified. Neither key rotation nor a short quiet window
was sufficient evidence that monthly spend was under control.

## Completed corrective actions

- Rotated the gateway credential, synchronized its deployment secret files and
  restarted the running container. Old-key rejection and new-key acceptance were
  verified without exposing credentials.
- Removed EVM history from active and durable polling. EVM-only ticks report zero
  polling watches so the alarm can disarm without deleting registrations/replay.
- Added a final Zerion transport refusal for `background_monitor` and
  `realtime_poll` contexts. Refusals are recorded as `policy_blocked`, separate
  from physical upstream attempts.
- Added regression coverage proving zero Zerion fetches from live subscriptions,
  repeated durable ticks and restarts, while explicit reads and UTXO monitoring
  continue to work. Local validation passed 285 tests and both TypeScript projects;
  two optional cache tests were skipped. Deployment CI passed.
- Persisted gateway request metrics in PostgreSQL and production provider metrics
  in MongoDB, independently of the unreachable legacy admin metrics service.

## Efficiency safeguards and release status

- Gateway PRs [16](https://github.com/BitHighlander/keepkey-gateway/pull/16) and
  [17](https://github.com/BitHighlander/keepkey-gateway/pull/17) enforce cache-only
  automatic portfolio/history reads. Focus, degraded retries and swap reconciliation
  cannot trigger paid Zerion discovery. An explicit user refresh remains available.
  Live verification of three automatic portfolio refreshes recorded zero additional
  physical Zerion attempts.
- Shared PostgreSQL reservations count each physical Zerion attempt before the
  fetch, including failed attempts, across instances and credential rotation.
  Database failures fail closed for paid discovery; existing cached data remains
  available. Concurrent-instance tests exhausted a five-request allowance with
  exactly five reservations, including the single-connection cache path.
- [Gateway PR 18](https://github.com/BitHighlander/keepkey-gateway/pull/18) replaces
  temporary emergency ceilings with 120 requests/minute, 10,000/UTC day and
  250,000/UTC calendar month. These configurable application request ceilings
  prevent runaway traffic; they are not an exact provider credit or invoice cap.
  Necessary capacity can be increased without restoring background polling.
- Durable budget alerts at 50/80/100 percent are deduplicated in PostgreSQL and
  written to structured logs. The authenticated `/api/v1/provider/usage` endpoint
  exposes warning/limited status without calling a paid provider. Desktop displays
  warnings in the dashboard; the new Desktop binary must be released to deliver
  that UI to installed clients.
- Gateway counters include a non-secret credential fingerprint, refresh reason,
  operation/source, client attribution, forced refresh, status and latency.
  Zero-count heartbeats distinguish an idle collector from missing data. Metrics
  flush every ten seconds with 30-day retention; a crash can lose unflushed
  diagnostic counts. The atomic request ledger enforces limits independently.
  Legacy production provider metrics are persisted in Mongo across all three pods.
- Desktop commit `29c0ace72` carries refresh intent through RPC and SDK requests,
  refuses unsupported automatic discovery before networking, and preserves cached
  balances. Pending EVM confirmations use receipt/head chain RPC rather than
  repeatedly discovering wallet history. Provider and wallet-session guards remain.
- Pioneer [PR 221](https://github.com/coinmastersguild/pioneer/pull/221) adds the
  same cache-only portfolio policy, stale discovery markers, Desktop provider status
  and a shared per-process Zapper failure circuit. Provider 5xx/rate failures pause
  discovery for five minutes; auth/credit failures pause for thirty minutes.
  This avoids repeatedly paying for a failing provider while preserving native RPC.
  The canary caught uppercase `Axios.post` call sites bypassing the first circuit
  implementation. Those calls now use the guarded instance, and an integration
  regression exercises every exported discovery operation before release.

Gateway validation passed 295 tests with isolated PostgreSQL and both TypeScript
projects. Desktop `make test-unit` passed 3,056 tests across 28 groups; frontend and
backend bundles succeeded. Full Desktop type checking is still blocked by existing
repository dependency/type errors; it is not reported as passing. Focused receipt
and refresh-policy tests passed after the final source edits.

Historical billing totals are not a closure gate. Closure means automatic work
creates no paid discovery traffic, explicit reads remain available, failed-provider
retries are bounded, metrics identify future traffic, and the Desktop change is
included in the release. Backend deployment verification is recorded below.

Automatic discovery of new incoming EVM payments still needs a separate push
source if that product behavior is required. Known pending transaction confirmation
tracking continues through chain RPC. Gateway hostname migration, legacy swap
continuity, and the Desktop provider-fallback handoff remain separate release work.

## Final backend deployment verification

- DigitalOcean production `api.keepkey.info` runs Pioneer 1.4.7 on all three
  replicas, zero restarts at verification, pinned to the tested image digest
  `sha256:768446396e73030e59f09dd65fc20fb687981bf5a13b6db5b60b7093e3e85cca`.
  Each pod and the public health endpoint returned version 1.4.7. Three public
  cache-only portfolio refreshes produced zero Zapper attempts for the probe
  caller, and all three pods had recent durable collector heartbeats.
- Cloudflare `oracles.cc` and `api-blue.keepkey.info` serve revision
  `39b3e27003349fbbfe7af1535c20a1d989d5ca09`. An explicit history request returned
  200, followed by three automatic portfolio refreshes and one automatic history
  refresh with zero additional Zerion attempts. The cached history reported
  `cached: true, fresh: false`. The status endpoint confirmed the new monthly
  request ceiling of 250,000.
- Gateway full validation after the capacity change passed 295 tests with no
  failures and both TypeScript checks. The final deployment workflow succeeded.
  Pioneer release-candidate CI succeeded, including transport and exported-client
  circuit regressions; generated TSOA and server TypeScript checks passed.
- The isolated canary and local test PostgreSQL container were removed. The
  unrelated DigitalOcean inference service and production hostname routing were
  not changed. The old production image remains available as rollback target:
  `sha256:9665ea53d892a1937d8cdf48d5175e6c7ca5f84fcee33401a728940c3f3bd0ae`.
- Production was rolled out directly using the authenticated local Kubernetes
  context. The duplicate merge-triggered workflow was cancelled before its deploy
  work; its cancellation-triggered rollback job failed at DigitalOcean kubeconfig
  authorization (403), before any restore/restart. All three pinned image IDs were
  verified afterward. Repairing the CI DigitalOcean credential remains deployment
  maintenance, separate from provider-efficiency behavior.

The Desktop source commit is ready for the owner's Vault release. Installed older
binaries do not gain refresh-reason enforcement or the alert UI until updated;
legacy/manual HTTP compatibility remains supported by the servers. Existing
unmarked callers are identifiable in the metrics as legacy traffic.

## Source references

- [Original active and durable monitoring change](https://github.com/BitHighlander/keepkey-gateway/commit/4d8ae770bd6ff37a3411407c1ecc6384a10de10c).
- [Prior wallet-core polling implementation](https://github.com/BitHighlander/keepkey-gateway/blob/7f738b701e543b001adfcf5d47b6c72c6ed9a5b7/container/src/realtime.ts).
- [Legacy Zapper refresh path](https://github.com/coinmastersguild/pioneer/blob/c2287456502479e87de4c5ea2873822d64b390d9/services/pioneer-server/src/controllers/charts.controller.ts#L272).
- [Legacy refresh defaults](https://github.com/coinmastersguild/pioneer/blob/c2287456502479e87de4c5ea2873822d64b390d9/services/pioneer-server/src/config/portfolio-runtime.config.ts).
- [Current gateway policy and metrics queries](https://github.com/BitHighlander/keepkey-gateway/blob/668b52c0f705461210e3bd52359f6c762d101766/docs/ZERION-USAGE.md).

Private operator verification artifacts remain outside the repository. No API
credentials, raw wallet identifiers or customer query keys are included here.
