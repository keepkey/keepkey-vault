# Release reliability audit — 2026-11-10

Reviewed `4bbc479829d324bd3e94bb3383a28cfa3217f224` and the working fixes below.
Published comparison: v1.6.10 `88caa37014a45b154bbec8d8805f0ceffd2467eb`;
context: v1.6.9 `6e12d01ea23ebfa24f8e6f7358efcccd3b224484`, stable v1.6.7
`e3b416c4eaeec85b73b9a92a0621a909317c11c7`.

Scope: default portfolio and receive flows, account/history cache lifecycle,
device changes, settings updates, and navigation. Optional features that default
off were read for isolation but are not represented as acceptance-tested. All
runtime evidence below uses synthetic RPC data and an isolated browser/component
fixture; no wallet, device, production API, seed, or user profile was touched.

## Confirmed and fixed: P2 — a late initial cache can undo a newer balance

Before the working fix, the live Dashboard mount effect constructed a new map
from `getCachedBalances` and replaced the whole displayed map. A balance pushed
after that cache request began could therefore disappear when the older cached
reply arrived. This bypassed the existing full-refresh versus push timestamp
guard. It also allowed a pre-purge cache reply to repopulate a cleared portfolio.

Reproduction with the actual Dashboard: hold `getCachedBalances`, push a confirmed
7 BTC balance, observe `7.0000 BTC`, then release the earlier 0.25 BTC cache. The
previous source displays `0.250000 BTC` again, without a browser error. Source
comparison confirms this path existed in v1.6.10 and v1.6.7; it is an inherited
reliability defect, not a regression introduced by the current release.

Working change in `projects/keepkey-vault/src/mainview/components/Dashboard.tsx`:

- Mount-cache reads capture a snapshot revision and wallet-cache scope.
- Cache rows merge only into chains untouched by a newer accepted read/push.
- Monotonic revisions cover events in the same millisecond; confirmed zero is
  authoritative. Existing stale/degraded preservation rules still apply.
- `wallet-data-purged` retires pending initial-cache results.

Validation: actual-Dashboard isolated fixture `__tests__/dashboard-device-errors.test.ts`
passes 16 assertions, including positive/zero pushes, a completed forced read,
and purge before cache completion. Existing local contention, provider-error,
stale-age and recovery assertions remain green. Browser runner
`__tests__/fixtures/core-regression/dashboard-cache-race.mjs` passes current source
and fails with the exact previous Dashboard injected via
`QA_DASHBOARD_BASELINE_FILE`.

Evidence: `/private/tmp/keepkey-release-audit-20261110/dashboard-cache-proof.json`
records the original reproduction; the current browser result is
`dashboard-cache-race-results.json` in the same directory. Negative-control log:
`/private/tmp/keepkey-dashboard-cache-before-20261110.log`.

## Remaining investigation, not confirmed runtime findings

- The watch-only refresh branch at `Dashboard.tsx:1316` has no device-id/generation
  fence. App reuses its Dashboard when switching watched device IDs. An old
  refresh may therefore arrive after a new watched wallet's cache. This path is
  also inherited from v1.6.10; a separate actual-component proof is still needed.
- The one-shot market-price effect at `Dashboard.tsx:1261` has no dependency array,
  sets its ref before its request completes, and cancels on any subsequent render.
  Its ref prevents retry after that cancellation. This structure is inherited
  from v1.6.10 and v1.6.7; a delayed-response runtime proof is still needed before
  changing it.

## Boundaries checked without another confirmed release regression

- Receive's production changes add technical-detail/path-edit visibility options;
  default address-verification behavior is unchanged. Account-derived EVM paths
  remain coupled to their selected account; unknown selected owners do not
  authorize send/quote preparation. BTC request cancellation and xpub identity
  dependencies remain present.
- `useRecentActivity` sequences requests and invalidates on every ready-state
  push. The ordinary seed-changed path emits such a push. A silent manager-only
  purge does not directly reach the hook; that narrower edge was shared with the
  security audit rather than counted twice here.
- Swap history changes since v1.6.10 are display-character corrections. Existing
  query ordering/cancellation limitations were not presented as new regressions.
- Settings' new layout keeps independent handlers and flags; the password flag
  remains separate from Monero. General provider/secret boundaries are covered by
  the security audit. Settings reads can still resolve out of order, an inherited
  pattern without a confirmed new mutation or trust bypass in this pass.
- The `setShowNameReg(v => !v)` TypeScript diagnostic is not by itself a runtime
  defect: the live wrapper forwards the updater to React, while watch-only mode
  rejects opening. No change was made solely to remove that diagnostic.

No dead-code deletion was justified by a reproduced default-flow failure in this
pass. Unused symbols and compatibility branches were left for a separate cleanup.

## Scoped security follow-up: Monero hidden-wallet release policy

Root subsequently assigned the new Monero hidden-wallet persistence finding from
`security.md`. The accepted release policy blocks hidden-wallet monitoring and
spending before device, watch-cache, pending-file, or sidecar-wallet access. The
shared check uses both the engine's hidden-session classification and reported
device state. Polling returns a safe empty status and the translated instruction:
“Monero is unavailable in hidden wallets. Switch to your standard wallet to use
Monero.” Automatic connect/failover is suppressed, and entering a hidden wallet
invalidates the previous monitor. Generic node Status/Stop cleanup remains usable.

Pending/discard hydration is lazy and occurs only after policy admission. Standard
wallets keep their signed-transaction recovery blocks. Existing records/files are
not automatically erased, migrated or broadly purged; previously persisted data
requires a separately reviewed cleanup policy.

Independent security review found and resolved one integration issue before
freeze: `getAppSettings` previously called the wallet getter unconditionally to
count pending transactions. That would make every hidden-wallet settings load
throw under the new policy, including with Monero off. Actual AST-extracted
`getAppSettings`/factory tests now verify hidden/off and hidden/on settings remain
usable with no wallet getter/store construction and preserve unrelated feature
flags. Enabled standard wallets retain their pending count.

The retained vault tests cover all hidden wallet actions, both hidden identity
signals, transitions during consent and polling, zero monitoring SQL/key access,
and unchanged pending recovery on return to standard mode. Failover tests prove
zero public probes or wallet connection after hidden admission/transition. The
actual component fixture shows the actionable message without automatic device
consent or extra buttons. Standard synthetic hardware, receive, signing, and
pending-broadcast tests remain part of the combined run. These are isolated policy
tests, not acceptance testing of a newly enabled production feature.

Negative controls: the exact previous vault passes its 25 original cases and
fails all six new privacy/lifecycle cases (`/private/tmp/keepkey-monero-policy-negative.log`).
Removing only the settings redaction reproduces the hidden settings failures
(`/private/tmp/keepkey-monero-settings-negative.log`). Current combined results:
`/private/tmp/keepkey-monero-hidden-policy-20261110.log`. All follow-up test commands
set `VAULT_API_URL=http://127.0.0.1:9`; no actual API, device, daemon, profile, or OS
keychain is used.

## Running the retained browser check

From `projects/keepkey-vault`, with Playwright and its test package installed:

```sh
VAULT_API_URL=http://127.0.0.1:9 CORE_QA_PORT=5209 bun __tests__/fixtures/core-regression/server.ts
VAULT_API_URL=http://127.0.0.1:9 CORE_QA_PORT=5209 CORE_QA_EVIDENCE=/tmp/vault-dashboard-qa node __tests__/fixtures/core-regression/dashboard-cache-race.mjs
```

`CHROME_EXECUTABLE`, `PLAYWRIGHT_MODULE`, and `PLAYWRIGHT_TEST_MODULE` support the
same external-browser/module paths as the other core fixture scripts. Run browser
scripts sequentially against one fixture instance because its synthetic swap
state is shared. For a negative control, set `QA_DASHBOARD_BASELINE_FILE` to an
export of the prior `Dashboard.tsx` when starting a separate fixture server.
