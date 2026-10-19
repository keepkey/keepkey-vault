# Bitcoin PSBT and watch-only validation

This feature supports Bitcoin mainnet single-signature BIP44, BIP49, BIP84 and
BIP86 accounts. Taproot signing is BIP86 key-path spending with SIGHASH_DEFAULT.
Script trees, annexes and other Taproot sighashes are refused before signing.
Electrum wallet-file export supports BIP44/49/84. Desktop public-wallet files
support all four account types and explicitly carry the mainnet network,
master fingerprint, account path, script type, xpub, receive branch 0 and change
branch 1. Import one through the wallet selector or by dropping the file.
No private keys or node credentials belong in a public-wallet file.

## Offline operation and restart recovery

The **computer** is disconnected from the network. KeepKey communicates with
that computer over **USB**. Desktop's offline setting suppresses app network
requests; physically disconnecting the computer is a separate operator action.
Removable media, USB communication and transaction parsers remain attack surfaces.
Verify recipients, amounts and fees on KeepKey. An offline computer can validate
transaction structure and the supplied previous transactions, but cannot
independently know whether an input has subsequently been spent. Online chain
state and broadcast acceptance remain separate checks.

1. On the offline computer with KeepKey connected, export the selected account
   using **Save Desktop public wallet**. Confirm the account and script type.
2. Import this file on the online computer. KeepKey never needs to connect to
   the online computer. Imported addresses remain unverified until checked with
   the matching device; compare receive addresses out of band.
3. Configure the online computer's node. Select the saved wallet, create a PSBT,
   review its fee and outputs, and retain the exported unsigned file.
4. Transfer that file to the disconnected computer. Drop it on Desktop,
   review/sign using KeepKey over USB, and retain the saved signed PSBT.
5. Transfer the signed file back to the online computer, drop it on Desktop,
   review and explicitly broadcast through the selected backend.
6. Restart each application between these steps. Reopen the saved watch-only
   wallet and drop the unsigned/signed file again. In-memory review IDs expire
   intentionally; no prior review or confirmation should be restored as approval.

An automated four-process regression executes public-wallet export, watch-only
creation, signing with the public test key, then reloading SQLite settings,
account metadata and signed-file fee/output review in a fresh process. It uses
synthetic chain data and does not prove two physical PCs, a real node, device
signing after a restart or a funded broadcast.

## Automated checks

Run `make test-unit` from the repository root. The PSBT suites are included.
The BTC backend Core suite is a script-style runner, invoked separately by make.

Real Electrum 4.8 interoperability, offline:

```sh
ELECTRUM_SOURCE=/path/to/electrum-4.8 \
ELECTRUM_PYTHON=/path/to/electrum-venv/bin/python \
bun scripts/test-btc-electrum.ts
```

Run this from `projects/keepkey-vault`. Install Electrum's requirements in the
isolated Python environment first. Six round trips cover all three supported
Electrum account types, with known and unknown origins. They check wallet
upgrades, master fingerprints, five receive addresses, PSBTs and independently
produced signatures in both directions. All keys in this test are the public
BIP39 `abandon … about` vector.

Sparrow Taproot interoperability uses the classes from the installed application:

```sh
jimage extract --dir /tmp/sparrow-classes /path/to/Sparrow/runtime/lib/modules
SPARROW_CLASSES=/tmp/sparrow-classes SPARROW_JDK=/path/to/jdk \
bun scripts/test-btc-sparrow.ts
```

Two offline round trips check BIP86 origins, first five addresses, finalized
PSBTs, txids and fees. Sparrow signs independently; Desktop verifies its Schnorr
signatures. This check uses Sparrow's Bitcoin library, not GUI automation.

## Physical KeepKey

Close Desktop and Sparrow before the standalone hardware check to avoid USB
contention. Use an initialized, unlocked device. The script never broadcasts,
reads a seed or spends actual UTXOs: its funding transactions are synthetic.
Its evidence directory contains public account data.

```sh
BTC_PSBT_EVIDENCE_DIR=/tmp/keepkey-psbt-evidence \
bun scripts/btc-psbt-hardware-check.ts --sign
# To test only Taproot:
BTC_PSBT_EVIDENCE_DIR=/tmp/keepkey-psbt-evidence \
bun scripts/btc-psbt-hardware-check.ts --sign --only=p2tr
```

Confirm each recipient and the total/fee on the device. Each transaction pays
60,000 sats, returns 39,000 sats as hidden change, and pays a 1,000-sat fee.
The host verifies the returned transaction and every signature before saving
the signed PSBT. Five addresses per account are compared with the device.

Also exercise the actual Desktop UI: copy/export the account, drop an unsigned
PSBT, inspect the output classifications, sign, and load the signed file in
the other wallet. Check cancellation and a different device/seed/passphrase.
In offline mode, signing must work and broadcast must be unavailable.

## Online and own-node checks

Use watch-only Create PSBT, sign on the offline machine, and return the signed
file to the online machine. Review every output before broadcasting. Verify the
returned txid and confirm only the configured backend handles chain traffic.

Bitcoin Core's `scantxoutset` cannot prove the next unused change index, so Core
builds requiring change are refused; send-max is supported. Blockbook supports
change-address discovery. Neither adapter falls back to a public backend when
an own node fails. Missing fee estimates or previous transactions fail closed.

The two-PC transfer and live own-node scenarios require those environments;
unit tests and synthetic transactions do not substitute for those checks.

Core's current adapter does not discover wallet transaction history. Archival
storage and `txindex=1` do not enable a missing discovery implementation. Coin
selection, custom fee controls and fee-bumping are separate advanced-workflow
items; the existing fee-level selector and RBF indicator do not establish them.
Own-node watch-only requests select their backend from the named saved wallet,
even before a view notification or after a different device connects. The node
configuration remains a persisted Desktop setting, not a portable credential in
the public-wallet file. Optional hosted fiat quotes must not prevent refreshing
the node's UTXO balances; unavailable/cached fiat valuation is disclosed separately.
If a node is configured but no eligible saved wallet is selected, generic
signed-file review/broadcast must refuse rather than offer Pioneer. Changing
node settings, including a different node of the same type, requires a new review.

## Cross-application acceptance matrix

Native SegWit is the first required physical end-to-end demonstration. Each
cell includes creation/export in the row application, physical KeepKey signing
through the column application, signed-file return, finalization and broadcast
review. A library round trip or standalone hardware signing check does not
complete a cell. Public broadcast requires a deliberately funded test.

| Online creator → offline signer with KeepKey | Sparrow | Electrum | Desktop |
| --- | --- | --- | --- |
| Sparrow | Pending exact device demonstration | Pending exact device demonstration | Pending creator UI/device demonstration |
| Electrum | Pending exact device demonstration | Pending exact device demonstration | Pending creator UI/device demonstration |
| Desktop | Pending signer UI/device demonstration | Pending signer UI/device demonstration | Synthetic signing tested; two-PC/restart/funded demonstration pending |

Then repeat legacy, wrapped SegWit, account changes and passphrases as distinct
cases. Multisig is outside Desktop's current single-signature PSBT support and
must be refused; it is not covered by any single-signature result.

Taproot needs a separate matrix. Sparrow's current KeepKey USB integration
rejects Taproot recipients and reports Taproot signing unsupported in
[KeepkeyClient.java](https://raw.githubusercontent.com/sparrowwallet/lark/master/src/main/java/com/sparrowwallet/lark/KeepkeyClient.java).
Electrum's current [KeepKey plugin](https://github.com/spesmilo/electrum/blob/master/electrum/plugins/keepkey/keepkey.py)
does not list Taproot among its supported wallet types. Firmware support and
Sparrow library interoperability do not remove these host-plugin restrictions.
Upstream fixes need protocol mappings, firmware capability checks, device tests
and maintainer acceptance, not merely deleting a refusal. No upstream plugin fix
is claimed by the Desktop implementation.

[Electrum's cold-storage guide](https://electrum.readthedocs.io/en/latest/coldstorage.html)
establishes the online watch-only/offline-signing pattern, not every KeepKey or
cross-application combination. Sparrow also documents a direct
[Bitcoin Core connection](https://sparrowwallet.com/docs/connect-node.html).

## Evergreen narration and firmware acceptance

Use the application/firmware names in narration; keep specific versions and dates
in the demonstration evidence. Bitcoin-only firmware narrows supported coins;
it does not imply that the computer is offline.

Suggested coordinator narration:

> KeepKey Desktop is a convenient online coordinator for KeepKey. Your private
> keys stay on the device, and you approve transactions on its screen. You can
> also use KeepKey with Sparrow or Electrum. Whichever application you choose,
> blockchain servers must never become an authority for software updates.

KeepKey with Electrum retains the hardware signing boundary. An online software
wallet holding the seed has a different risk profile. Desktop's hosted backend
receives wallet queries and affects privacy, availability and data accuracy;
demonstrate device verification, authenticated downloads, own-node routing and
clear treatment of untrusted server errors rather than asserting that other
wallets' servers are inherently dangerous.

The Electrum incident involved malicious server transaction-error messages
persuading users to download fake upgrades. The server did not automatically
install an update. Electrum fixed the relevant display/error mechanism; omit
dates and versions from narration. See the
[maintainer incident report](https://github.com/spesmilo/electrum/issues/4968).

Show firmware verification as three distinct checks:

1. Rebuild source and compare the application payload with the published payload.
2. Verify publisher signatures using authenticated verification keys.
3. Cross-check the installed image with the device-reported hash.

A download hash comparison is an integrity check, not a source rebuild. A matching
hash does not establish that the source is bug-free. The preinstall notice must
state the check Desktop actually performs.

The complete offline firmware package remains a release gate: exact source and
recursive submodules, toolchain image pinned by digest and exported locally,
all verification dependencies, authenticated reference artifacts/keys, and
instructions rehearsed from a clean machine with networking disabled. Record
the built payload comparison and a deliberate altered-artifact failure. Existing
local analysis/signature/flashing machinery alone does not complete that package.

Record episodes only after a completed end-to-end demonstration, with a failure
case. Preserve the order: PSBT exchange → public-wallet portability → persistent
own-node routing → upstream host compatibility → offline build rehearsal.

## Final review evidence — 2026-10-18

- Full regression: 1,557 tests, 53 worker tests, 35 Core backend assertions,
  and the standalone Cosmos/flags suites passed. The development app built.
- Electrum 4.8.0: all six offline round trips passed.
- Installed Sparrow 2.1.2 library: both Taproot round trips passed.
- Physical KeepKey 7.14.3 Bitcoin-only: all five BIP86 receive addresses matched;
  the synthetic transaction signed after two confirmation requests.
- Actual Desktop, offline mode: dropped/reviewed/signed the Taproot PSBT,
  saved its finalized file, and reopened it in broadcast review with the
  correct fee and txid. The broadcast button was absent while offline.
- Sparrow independently verified that physical-device Schnorr signature,
  its master fingerprint, five addresses, fee and finalized PSBT.
- Actual Desktop: imported a different BIP86 account, confirmed the explicit
  path choice, retained watch-only mode with the connected nonmatching key,
  and showed the unverified-address warning. The Bitcoin-only dashboard,
  navigation and command palette were checked after correcting their scope.

No real UTXOs were spent or broadcast by these checks. A live-node broadcast
and transfer between two physical PCs remain release-environment checks.

Follow-up hardware evidence: the physical Bitcoin-only KeepKey signed a native
SegWit synthetic PSBT after two confirmation requests. Its first five BIP84
receive addresses matched host derivation; Desktop verified the returned ECDSA
signature and saved the finalized PSBT. This was a standalone hardware runner,
not a Sparrow/Electrum plugin or two-PC demonstration.
Real Electrum 4.8 independently verified that device-produced native SegWit
signature, the account origin, five addresses, fee and signed PSBT. Reproduce
with `PYTHONPATH=/path/to/electrum python scripts/test-btc-electrum.py
/path/to/hardware-evidence --hardware`; no Electrum USB plugin is exercised.

Follow-up regression: 1,572 unit tests, 53 worker tests and 35 Core assertions
passed, as did the standalone Cosmos/flags runners and the development app build.
Typecheck retained the same 1,034 baseline diagnostics, with no new diagnostics.
