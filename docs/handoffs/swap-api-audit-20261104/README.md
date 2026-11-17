# Vault swap API audit — 2026-11-04

Develop and the running development app include the NEAR refund fixes, the
progress regression fix and API input locks. The tested hardening commit is
`2d1e5a19f4a06bff292752d1984261a1ed2bb4b7`, merged into develop as
`ff0d71229ee874e0d96b2057d694de1b8aaea1e4` via
[PR616](https://github.com/keepkey/keepkey-vault/pull/616). The local checkout is
fast-forwarded to that develop result and its source tree matches the running
development build. The app still carries version 1.6.9;
these changes are not part of the published v1.6.9 prerelease. No version bump,
tag, signed release build or release upload was performed during this audit.

## Fixes integrated into develop

- [PR612](https://github.com/keepkey/keepkey-vault/pull/612): apply the independent
  Pioneer/1Click refund and payout checks to XRP and TRON plain deposits.
- [PR613](https://github.com/keepkey/keepkey-vault/pull/613): repeat the registered
  deposit check at execution, before building/signing. Reject required memos,
  wrong refunds/payouts, expired or consumed channels, malformed responses,
  prebuilt replacements and mismatched execution networks. The final isolated
  safety suite passes 217 cases; 69 execution cases reproduced the bypass before
  that fix, alongside the original 133 passing quote cases.
- [PR614](https://github.com/keepkey/keepkey-vault/pull/614): stop stale Pioneer
  pending responses from overwriting NEAR processing; preserve reached statuses
  and UI checkpoints for each transaction. New transactions reset their progress.
  Refund/failure remain explicit outcomes, and payout evidence still determines
  completion. REST and renderer guards lock inputs during signing and while a
  submitted receipt is displayed. The API snapshot uses the frozen sent amount.
  Six existing swap risk suites (126 tests) are now part of `make test-unit`.
- [PR615](https://github.com/keepkey/keepkey-vault/pull/615): an older overlapping
  poll returns the already settled result without another completion event or
  ledger write. The regression checks exactly one entry with the actual payout.

## Live results

All four funded swaps settled above their minimum output. The user confirmed
signatures on hardware; the ETH-to-XRP leg and final XRP MAX leg were started manually by the user.
The user explicitly confirmed both manual starts; automation did not submit the
MAX confirmation. No other funded trial was started by this follow-up.
Wallet addresses and transaction hashes are omitted from this report.

| Source | Actual destination payout | Minimum | Independent destination check |
| --- | --- | --- | --- |
| 0.003 ETH | 0.075849235 SOL | 0.075078426 SOL | Confirmed Solana transaction credited exactly 75,849,235 lamports to the intended wallet |
| 0.02182857 ETH | 40.315342 XRP | 39.898168 XRP | Validated XRP ledger transaction delivered exactly 40,315,342 drops to the intended wallet |
| 3 XRP | 0.001571402813565234 ETH | 0.00155553545313962 ETH | Successful Ethereum receipt; direct payout recipient and 1,571,402,813,565,234 wei match |
| 36.313362 XRP (manual MAX) | 0.019381269132034051 ETH | 0.019183694689948709 ETH | Validated source amount, 1,000-drop fee and 1 XRP retained reserve; successful Ethereum receipt and exact 19,381,269,132,034,051-wei payout |

1Click settlement was also checked against the actual signed input, source and
destination asset identities, refund/payout addresses, deposit and minimum.
Source confirmation alone was never treated as completion. The final XRP source
test exercised the new refund verification before execution with AdvancedMode
off. An empty API input update against its submitted receipt returned HTTP 409.

The initial quote scan issued 42 requests: 32 route cases and 10 invalid-input
cases. Of the route cases, 22 returned quotes (15 NEAR Intents, four Maya, three
THORChain); 10 were unavailable or rejected by limits/catalog checks. All 10
invalid-input cases were rejected. See [quote-scan.json](quote-scan.json), which
contains no wallet addresses or credentials. The scanner used hypothetical
amounts as well as funded balances; a quote does not imply a funded execution.

Small native TRX and USDT-on-TRON NEAR quotes both reported a temporary $100
minimum. The existing TRX balance was below that threshold, so no funded TRON
source test was executed. A quote-only TRX case above that threshold passed its
registered deposit/refund checks. TRON native/TRC20 building and refund-safety
boundaries were covered by offline builder tests and the unsafe-record suite.

## Validation

- Final `make test-unit`: 2,886 Bun tests and 17 script assertions pass.
- Both polling-order regressions failed before the progress fix and pass after
  it. Coverage includes processing followed by stale pending, a late poll after
  completion, disappearing confirmations, transaction identity changes, explicit
  failure/refund and API authentication/input locks.
- Backend, Vite UI and the local macOS development app build successfully.
- Typecheck retains the existing 813 diagnostics; the final comparison
  added no diagnostics when source line numbers were
  normalized. This is not a clean typecheck or a signed release certification.
- No runtime submodule pins or firmware sources were changed.

## Additional hardening integrated into develop (PR616)

- XRP MAX now reads validated account/owner reserves and subtracts the entire
  signed 1,000-drop fee in exact integer drops before quoting. The immutable net
  amount drives preview, execution, displayed cost and tracking. Cached balance
  floating-point tail digits are not treated as the actual MAX deposit.
- Quotes now have server-issued IDs, immutable execution terms, wallet/API
  session binding, independent-price cost policy, 30/60-second expiry, replay
  protection and serialized execution. Caller-supplied assets, amount, deposit,
  memo, router, payload, account and precision changes are rejected. Session and
  age checks repeat immediately before each signature. Expired EVM deadlines
  cannot be silently extended.
- REST prevalidates before its human approval card. An initial invalid-request
  probe exposed the old ordering by opening a card with a misleading blind-sign
  warning; the request was cancelled without signing/broadcast. Nine real-HTTP
  regressions prove zero cards for invalid requests, retained human approval for
  valid requests, correct MAX review amounts, and rejection when a quote ages
  during approval. A plain native EVM deposit no longer falsely requires
  AdvancedMode. No device policy was changed.
- Live forged-ID, altered-deposit, altered-amount and expired-quote probes now
  return HTTP 409 immediately without an approval card or signature. Missing ID
  and malformed positive-decimal input are covered by schema/HTTP tests.
- The REST asset boundary resolves firmware-eligible chain and indexed token
  metadata independently of the provider's short picker list. Ethereum USDC
  now quotes successfully. Synthesized EVM tokens need verified decimals.
- The cold lazy-dialog seed is delivered inside the mounted Suspense tree. A
  first-open USDC-to-XRP seed with amount 3 worked without a second `/set`.
- The final local app was built and exercised. GitHub CI was still in progress
  at merge; local test/build results above are not a claim of green remote CI.
  No submodule or firmware changes
  were introduced. The 813 pre-existing typecheck diagnostics remain unchanged.

## Remaining findings and coverage limits

1. The small Relay SOL route was previewed and correctly labelled as requiring
   blind review. It remains unsigned. No AdvancedMode policy was changed.
2. Small native/TRC20 TRON provider minimums still block a funded trial within
   the stated small-test budget. Offline builder and refund boundaries pass;
   that does not establish funded mainnet TRON signing/settlement.
3. Invalid amount syntax now returns HTTP 400. Provider address/route failures
   can still report gateway errors; this does not mean local DNS is broken.
4. This is a broad implementation/route audit, not exhaustive execution of every
   token pair, a funded refund scenario, or release sign-off. Full emulator and
   macOS release gates remain. No new version/tag/artifact was published.

Detailed signed-term and chain-RPC evidence remains private under
`/private/tmp/vault-swap-audit-private/`; it was not added to git or published.
