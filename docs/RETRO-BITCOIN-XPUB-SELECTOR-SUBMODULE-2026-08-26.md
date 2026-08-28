# Retro: Bitcoin xpub selector disappeared after hdwallet pin rollback

Date: 2026-08-26
Affected surface: Vault Bitcoin asset page / bitcoin-only dashboard
User-visible symptom: the account and script-type selector area was blank

## Executive summary

Vault's Taproot discovery code and its pinned hdwallet implementation fell out
of sync during a parent-repository merge. Vault asked the device for four
Bitcoin account xpubs, including P2TR. The selected hdwallet pin claimed P2TR
support but could not translate `p2tr` into the device protocol, so the entire
batch threw. The account manager remained empty, and the frontend intentionally
rendered nothing for an empty account set while also swallowing the RPC error.

The selector component itself had not been removed. Repeated UI repairs could
not make the control reliable because its required data producer was failing.

## Evidence and timeline

- `f797ad5e5` added capability-gated Taproot discovery to Vault.
- hdwallet `0572619c` added the corresponding host enum, feature gate, wire
  translators, and adapter tests. It is contained by hdwallet `87553b99`.
- PR-425 merge `69b19f07d` had parent 1 pinned to `87553b99` and parent 2
  pinned to older ClearSign branch commit `4e012e67`.
- The merge result selected `4e012e67`. That pin predates the Taproot host work.
- The running backend repeatedly logged:

  ```text
  [getBalances] BTC accounts init failed: unhandled InputSriptType enum: p2tr
  ```

## Failure chain

1. Vault called `btcSupportsScriptType('Bitcoin', 'p2tr')`.
2. The older adapter returned `true` for the unknown value because its predicate
   rejected only known unsupported SegWit combinations.
3. `BtcAccountManager` put BIP44, BIP49, BIP84, and BIP86 into one
   `getPublicKeys` batch.
4. hdwallet's old `translateInputScriptType` threw on `p2tr`.
5. Initialization had already reset `accounts` and never published account 0.
6. `AssetPage` rendered the selector only when `accounts.length > 0`.
7. `useBtcAccounts` discarded the initialization exception, leaving a blank
   layout slot with no retry or diagnostic.

## Why existing checks missed it

- The Vault Taproot capability test used a permissive fake wallet whose
  `getPublicKeys` accepted every string. It tested Vault's desired contract, not
  the pinned KeepKey adapter's real wire translator.
- hdwallet had correct Taproot tests on its newer branch, but parent-repository
  CI did not test the compatibility of the exact submodule gitlink selected by
  a merge.
- The parent build workflow built the application but did not run Vault's unit
  suite.
- Preflight checked that the working-tree SHA matched the parent gitlink and
  whether that SHA's own CI was green. It did not prove that the gitlink was
  compatible with the Vault code consuming it.
- An optional capability shared one all-or-nothing batch with the three required
  Bitcoin account types.
- The frontend converted a backend contract failure into absence of UI.

## Corrective changes

1. Derive the required BIP44/BIP49/BIP84 xpubs first and validate every result.
2. Derive optional BIP86 separately. A P2TR adapter failure is logged and
   degrades to the required three types instead of taking all Bitcoin accounts
   offline.
3. Treat a missing required xpub as an actionable initialization error.
4. Preserve the error in `useBtcAccounts`, retry when the device reaches
   `ready`, and render an error/retry control instead of an empty slot.
5. Import the checked-out hdwallet core enum and KeepKey translators directly
   from the Vault Taproot regression test. An old gitlink now fails the test.
6. Run the complete Vault unit suite in parent-repository CI after building the
   exact pinned modules.
7. Run the fast Bitcoin/hdwallet compatibility test during release preflight.

## Release gates

A release or merge is blocked unless all of these are true:

- The pinned hdwallet exposes `BTCInputScriptType.SpendTaproot` and
  `BTCOutputScriptType.PayToTaproot`.
- Its KeepKey translators map them to protocol `SPENDTAPROOT` and
  `PAYTOTAPROOT`.
- A wallet that falsely claims P2TR support but throws on P2TR still initializes
  Legacy, SegWit, and Native SegWit accounts.
- A missing required xpub fails explicitly and the Bitcoin page presents retry
  UI.
- `make test-unit` passes against freshly initialized, built submodules.

## Merge discipline

Submodule conflicts are API dependency decisions, not ordinary one-line merge
conflicts. Reviewers must compare both gitlink parents and choose or create a
descendant containing every required capability. A merge must never resolve a
gitlink solely by taking `ours` or `theirs`; the consuming repository's contract
tests are the authority.
