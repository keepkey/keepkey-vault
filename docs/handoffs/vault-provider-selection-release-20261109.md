# Vault release handoff: remove hardcoded Pioneer fallbacks

Date: 2026-11-09. Reviewed checkout: `keepkey-vault-v11`, HEAD
`6cf3339d42e95527f58974ef869c844a105ebeb4`, with existing uncommitted release work.
This handoff changes documentation only. The Vault release owner should implement
and validate the changes in their release branch.

## Goal and release context

Every wallet API operation must use the configured Pioneer provider, including
fallback branches and diagnostic actions. The November 8 migration plan targets
**https://api.keepkey.com** for the next Desktop default. **https://oracles.cc**
and **https://api-blue.keepkey.info** are gateway test hosts; legacy
**https://api.keepkey.info** stays available for installed releases.

Do not flip the Desktop default until the production hostname and gateway
migration gates are verified. This handoff can be fixed and released before the
hostname switch. Gateway usage instrumentation and polling fix are tracked in
https://github.com/BitHighlander/keepkey-gateway/pull/13.

## Findings verified in the current source

The three locations below contain literal legacy fallback URLs. Normal Desktop
wiring currently supplies the selected provider: `index.ts:2138` supplies the REST
callback, `index.ts:7114` supplies the transaction-builder base, and
`getAppSettings()` at `index.ts:1685` returns the resolved active base. The verified
problem is inconsistent fallback behavior if those inputs are absent or empty,
especially after changing the shared default. An actual runtime request leaking
to legacy while all these inputs are populated was not reproduced.

| Location | Current behavior | Required change |
| --- | --- | --- |
| `projects/keepkey-vault/src/bun/rest-api.ts:2536` | Hive sign-operations fetches `/api/v1/hive/tx-params` from `callbacks?.getPioneerApiBase?.() || 'https://api.keepkey.info'`. | Require a resolved provider dependency, or resolve the active provider through the canonical path. Missing wiring must not silently select a different server. Preserve the request's provider context through build/sign. |
| `projects/keepkey-vault/src/bun/txbuilder/index.ts:694` | Hive transfer construction passes `params.pioneerBaseUrl || 'https://api.keepkey.info'` to `buildHiveTransfer`. | Remove the literal fallback. Use the same provider snapshot as the passed Pioneer SDK/request, with explicit dependency validation or canonical resolution. Test the omitted-parameter branch as well as the normal injected branch. |
| `projects/keepkey-vault/src/mainview/components/SwapHistoryDialog.tsx:75` | `openSwapApi()` fetches settings and falls back to legacy before opening `/api/v1/swaps/pending/${txid}` in a browser. | Resolve through the shared default helper or, preferably, have the backend perform an authenticated diagnostic lookup using the configured provider and return a safe view. The gateway pending-swap route requires authentication; a bare browser URL has no Pioneer Authorization header. Never put the query key in the URL. |

The central policy already exists at
`projects/keepkey-vault/src/shared/pioneer-server.ts:1`:
`DEFAULT_PIONEER_API_BASE`, `resolvePioneerApiBase()`, and `isActivePioneerServer()`.
The backend's selected provider accessor is
`projects/keepkey-vault/src/bun/pioneer.ts:46`, `getPioneerApiBase()`.
Use those paths instead of introducing another independent default.

For swap diagnostics, `projects/keepkey-vault/src/bun/swap-tracker.ts:1104`
already implements `debugSwapLookup()`, including authenticated SDK lookups,
local ownership checks, and passphrase-wallet privacy gates. Reuse the existing
backend/RPC capability where suitable; preserve its privacy checks.

## Two related default-switch hazards

1. **Official server picker migration** — `src/bun/db.ts:296–313` seeds the
   official server only for an empty table, then inserts the resolved selection
   as another official/default row. After a default-host change, an existing
   database can retain legacy `KeepKey Official` with `is_default=1` and insert a
   second official/default row. Add an idempotent migration that establishes one
   current official row, keeps legacy usable as a normal saved server, preserves
   custom labels/selections, and does not overwrite an explicit saved API URL.
   An empty saved setting must continue to mean the current official default.
2. **Coin icons still depend on legacy** —
   `src/shared/assetLookup.ts:101` generates `https://api.keepkey.info/coins/...`.
   The gateway currently has no equivalent `/coins` route. Keep this dependency
   explicit and preserve icon availability, or ship a supported icon-source
   migration. Do not mechanically replace this host alongside wallet API URLs.

Relative paths above beginning `src/` are inside `projects/keepkey-vault/`.

## Acceptance checks for the Vault release

- Capture request destinations with a fake configured provider such as
  `https://selected-provider.invalid`. Exercise Hive transfer construction,
  Hive sign-operations, and swap diagnostics. Include omitted/empty injected
  base and missing-settings-field cases. Wallet operations must use the
  selected provider or fail explicitly before networking.
- Exercise empty/default selection with a distinct test official default.
  This catches hardcoded legacy fallbacks even while today's shared default
  still equals the legacy hostname.
- Change provider A to B during a slow operation. Results and signing inputs
  from A must not be applied to B; preserve existing generation/session guards,
  client/cache reset, and retirement of old realtime monitoring.
- Reopen an old SQLite database after changing the official default. Require
  one official/default picker row, preservation of saved custom/explicit legacy
  selection, and an idempotent second startup.
- Verify swap diagnostics authenticate with the selected gateway and do not
  expose a raw query key, another wallet's swap, or passphrase-wallet data.
- Re-run the existing provider tests:

  ```sh
  cd projects/keepkey-vault
  bun test __tests__/pioneer-server.test.ts \
    __tests__/pioneer-server-switch.test.ts \
    __tests__/pioneer-client-transition-isolated.test.ts
  ```

  Add focused regression tests for the actual call sites above, then run the
  release's normal `make test-unit` and build/type validation. Existing provider
  lifecycle tests alone do not cover these fallback branches.
- Search runtime source for `api.keepkey.info`, `api-blue.keepkey.info`,
  `oracles.cc`, and `api.keepkey.com`. Review each remaining literal by purpose;
  keep deliberate static-asset dependencies documented. Avoid rewriting test
  fixtures and explanatory comments as though they were active requests.

## Separate gateway cutover gates

The prior migration plan also requires legacy pending-swap continuity, capacity
testing, a read-only chain parity matrix, and a verified rollback path. Separate
legacy and gateway databases mean changing every URL consistently does not by
itself make old pending swaps available on the new service. Keep that gate open
until an explicit import/origin-aware tracking design is implemented and tested.
Do not silently send a transaction to a second provider to implement fallback.

Prior plan reference:
`/Users/highlander/.claude/projects/-Users-highlander-WebstormProjects-keepkey-stack-projects-keepkey-backend-v3/memory/project_api_keepkey_com_cutover.md`.

## November 10: Zerion reads must be on demand

The release owner clarified that Zerion data should load on wallet opening,
rather than through recurring transaction-monitor polling. Gateway PR #15
(`https://github.com/BitHighlander/keepkey-gateway/pull/15`) removes EVM history
from active SSE/socket and durable monitor loops, with a final transport guard
against Zerion requests in background contexts. EVM registrations/replay and
push routing remain; automatic EVM payment discovery requires a separate push
source. Explicit HTTP portfolio/history requests remain available.

That server change does **not** enforce once-per-open behavior for requests
initiated automatically by Desktop. Current `Dashboard.tsx` calls
`refreshBalances(true)` on window focus after five minutes, on degraded-chain
retries (30/60/120/300 seconds), after swap completion (immediate/30/90 seconds),
and every two minutes while terminal-swap reconciliation is pending. That path
calls `getBalances`, whose `GetPortfolioBalances` requests can reach Zerion on a
configured gateway. These callers look like ordinary HTTP requests to the server.

For the Vault release, carry an explicit refresh reason through the RPC and
provider request path. Permit paid Zerion refreshes for wallet opening and
explicit user actions. Automatic retries/reconciliation should reuse the last
Zerion snapshot and refresh only the necessary native/token data through direct
chain RPC or a push notification. Preserve the existing trusted-balance and
swap-reconciliation safeguards; do not replace failed reads with zero balances.

Acceptance: open a wallet and establish its positions/history; then exercise
focus, degraded-chain backoff and post-swap timers with fake providers. Those
automatic actions must create zero further Zerion fetches. An explicit refresh
must still fetch when requested, with coalescing across repeated chain entries.
Check the gateway's physical `upstream_*` counters, separately from cache hits.

The [provider usage retrospective](../handoff-provider-usage-retro-20261110.md)
records the provider split, change timeline, amplification mechanism, completed
mitigations and open incident closure criteria.

## November 10 implementation update

The efficiency changes described above are implemented in Vault commit
`29c0ace72` on `feat/password-bank-mvp`. Wallet opening and explicit user refreshes
may perform paid discovery; focus, degraded retry, swap reconciliation and background
balance updates carry cache-only intent. EVM history initialization is shared per
wallet session, and pending confirmations use chain receipt/head RPC. Old providers
without cache-only support cannot silently turn automatic requests into paid reads.
The dashboard reads inexpensive server status and displays budget/provider warnings.

Gateway PRs 15–18 contain the corresponding server controls. Pioneer PR 221 targets
legacy `.info` production with cache-only portfolio handling and Zapper failure
backoff. These changes do not flip the default hostname or complete the separate
fallback and cutover gates listed above.

Validation: `make test-unit` passed 3,056 tests, both Desktop bundles built, and
focused policy/receipt tests passed after final edits. Full Desktop type checking
still reports existing dependency/type errors. The commit is prepared in the Vault
release workspace; no signed Desktop binary was published as part of this work.
The owner's existing BTC/report edits remain uncommitted and separate.

The owner explicitly prefers efficient necessary calls and purchasing more capacity
when needed. Historical invoice reconciliation is not a required incident action.

Production verification completed: `.info` has three ready Pioneer 1.4.7 replicas
on the tested immutable image, and all three provider collectors persist heartbeats.
Three automatic public portfolio refreshes made zero Zapper attempts. Gateway
revision `39b3e27003349fbbfe7af1535c20a1d989d5ca09` passed a fresh explicit history
read followed by automatic portfolio/history refreshes with zero additional Zerion
attempts. Full deployment details and rollback digest are in the retrospective.
