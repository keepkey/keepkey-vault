# Vault release audit — November 10, 2026

The user requested an overnight review of release changes, visual consistency,
main-flow regressions, reliability, dead code, complexity and security, with a
reviewable morning candidate. This is a working evidence index, not release approval.

## Comparison baselines

Published release metadata was checked against GitHub on November 10.

| Baseline | Commit | Purpose |
| --- | --- | --- |
| v1.6.10, November 5 prerelease | `88caa37014a45b154bbec8d8805f0ceffd2467eb` | Primary comparison against the latest published build |
| v1.6.9, November 4 prerelease | `6e12d01ea23ebfa24f8e6f7358efcccd3b224484` | Earlier behavior where useful; annotated tag `3ae2c1c1` |
| v1.6.7, October 28 stable | `e3b416c4eaeec85b73b9a92a0621a909317c11c7` | Stable release comparison and wider security boundaries |

Develop starts at `97a2d39bb23117ba515e942ad9b46b69d6089852`.
The first fix batch is PR #634, head `92ac07211`. The complete audit and UI
integration is prepared on `integrate/release-audit-20261110` for version 1.6.11.
The original dirty password-bank workspace and user wallet state are preserved.

## Scope and review tracks

| Track | Scope | Evidence |
| --- | --- | --- |
| UI | Setup, firmware, PIN/lock, portfolio, sidebar, Receive/Send/Swap, history, settings, responsive layout and copy | [UI review](ui.md), in progress |
| Reliability | Async ownership, refreshes, account and history caches, navigation, settings updates, dead code and complexity | [Reliability review](reliability.md), in progress |
| Security | Always-on API, authentication, pairing/signing, wallet/session isolation, secrets, provider selection and disabled-feature boundaries | [Security review](security.md), in progress |
| Integration | Exact candidate commits, CI/platform packaging, regression gates and release limitations | This index, in progress |

Main-flow QA keeps optional feature acceptance disabled. The user's explicit
Zcash UI question receives a focused synthetic check. Regression suites use
isolated profiles and synthetic devices, and do not sign or broadcast real
payments. One mistaken live-only test requested an unapproved local pairing;
the incident and its limits are documented in the security report. No pairing
key was approved, and the coordinator verified that no pairing record was saved.

## Findings already addressed in the current candidate

- Pending selected-owner balances show a spinner rather than a completed failure.
- EVM addresses and amounts stay scoped to the selected account; quotes/builds
  wait for that account and ignore retired replies.
- Same-owner refreshes preserve drafts, amounts and the Receive view.
- The swap route artwork is restored inside the single trade summary. Network
  names and CAIP identities distinguish same-symbol cross-network routes.
- Canonical TRON/BSC aliases are accepted; conflicting route metadata is blocked.
- PIN, launch, lock and ordinary reads do not elevate the app. Signing and pairing
  approval focus retains its bounded lifecycle.
- The unified Zcash asset page was merged in PR #622. A remaining dashboard
  Privacy shortcut was found and removed during this audit. Thirteen unified-page
  checks and six actual-dashboard checks now pass.

## Validation so far

- Initial core regressions: 1,540 tests and 93 script assertions, zero failures.
- Final combined candidate: 1,581 core tests and 93 script assertions pass,
  including the local protocol-lock invariant and the Base icon regression.
- Swap browser QA: nine delayed-account/network cases and twelve review cases,
  no runtime errors; fixtures use synthetic balances and transactions.
- Focused dashboard/asset/token/default-off regression group: 20 tests pass after
  removing the remaining Zcash shortcut.
- Frontend/backend builds and all 15 locale checks pass.
- Type checking decreases from the known 800-diagnostic baseline to 799, with no
  new diagnostic signatures. The Receive QR change fixes the obsolete Chakra
  `sx` prop diagnostic. The repository does not have a clean typecheck.
- The native development preview is running; its API remains healthy while
  locked and its window uses normal layer 0. This is not a signed release artifact.
- The bounded UI audit captures thirty desktop/mobile states with no horizontal
  overflow or runtime errors. See the UI report for the exact limits.
- The combined UI is rechecked after integrating PRs #635–#641: all thirty states
  pass; shared Receive QR frames, SVGs and Copy actions are checked directly.
  PR #641's 320px update-button overflow is fixed. A portable browser regression
  passes 45 layout states, 36 callbacks and one timeout case with real components.
- Audit fixes for late Dashboard cache replies, cancellation before a later wire
  exchange, WalletConnect session/topic binding and Monero hidden-wallet
  persistence are implemented and independently reviewed. Monero policy and
  standard synthetic flows pass 153 tests / 825 assertions.

PR #634 Linux CI passed at `4bbc47982`; macOS crashed in the focus fixture's
native HTTP harness. The fixture now executes the same production router without
native HTTP sockets, keeps all twelve assertions and remains red against the old
focus code. Ten local repeats pass. Exact-head platform CI is running again;
the crash persisted without sockets. The final fixture also mocks USB/HID before
imports and forbids all native addons. It retains every assertion and remains red
against the old behavior. The final macOS CI result is still pending.

Local detailed results are under `/private/tmp/keepkey-swap-core-final-20261110`,
`/private/tmp/keepkey-swap-loading-20261110`, and
`/private/tmp/keepkey-swap-review-20261110`.

## Remaining release gates

Complete the three audit tracks, reproduce and triage findings, validate fixes,
run exact-head platform CI, review release packaging and produce a final candidate
record. Physical signing acceptance, signing/notarization and publication are
separate from the synthetic regression evidence recorded here.

The package version is advanced to 1.6.11; validate exact-head platform CI before
publication. UI PRs #635–#641 are reviewed and integrated locally with their
original commits preserved, including the responsive correction to #641.
Dependency reproducibility work restores a tracked Vault lockfile and makes CI
reject a missing lockfile. The only registry-version remediation is elliptic
6.6.1, replacing the vulnerable nested 6.5.4/6.5.7 copies. Bun 1.3.14's npm-alias
override issue is addressed with the reviewed local protocol lock entry and a
regression invariant. Do not regenerate that entry into a registry alias.
Remaining package advisories and their bounded reachability triage are recorded
in [dependencies.md](dependencies.md); this is not a clean advisory scan.
