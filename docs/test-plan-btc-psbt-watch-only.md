# Bitcoin PSBT and watch-only validation

This feature supports Bitcoin mainnet single-signature BIP44, BIP49, BIP84 and
BIP86 accounts. Taproot signing is BIP86 key-path spending with SIGHASH_DEFAULT.
Script trees, annexes and other Taproot sighashes are refused before signing.
Electrum wallet-file export supports BIP44/49/84; copy the BIP86 xpub,
fingerprint and path into Sparrow for Taproot.

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
