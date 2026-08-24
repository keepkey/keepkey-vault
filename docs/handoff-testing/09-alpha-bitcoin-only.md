# Alpha Bitcoin-only acceptance

Owner: BTC-only test lead  
Target: `alpha`, after firmware PR #534 (including merged #535 and its follow-up fixes) is included

Safety: the automated runner never wipes, resets, recovers, loads, changes settings, or broadcasts

## Release blocker found before device testing

The physical Bitcoin-only artifact at firmware head `b67e53547` did not contain
`KeepKeyBTC`. Physical firmware returned the ordinary `KeepKey` variant, while
Vault's Bitcoin-only boundary deliberately recognizes only `KeepKeyBTC` and
`EmulatorBTC`.

Consequences on physical hardware:

- Vault would render the multi-chain UI.
- Add Chain, ShapeShift, and WalletConnect would remain reachable.
- Vault's non-Bitcoin REST fence would not run, allowing background altcoin
  probes to reach a firmware that cannot service them.
- Flash-time inspection could not distinguish the Bitcoin-only image.

Firmware PR #534 now carries #535's physical-identity fix and adds a CI
assertion over the actual flashable ARM artifact. Do not spend physical-device
time on an artifact that predates #534's final green head, has a red Bitcoin-only
ARM job, or does not
embed `KeepKeyBTC\0`.

## Candidate preparation

Download the exact `bitcoin-only` artifact from the CI run for the candidate
commit. Record its SHA-256; do not use a filename or branch name as identity.
Start the alpha Vault build and connect an initialized, test-safe device flashed
with that artifact.

Run from `projects/keepkey-sdk`:

```sh
export BTC_ALPHA_HARDWARE_TEST=1
export BTC_ALPHA_ARTIFACT=/absolute/path/to/firmware.keepkey.bin
export BTC_ALPHA_EXPECT_FIRMWARE_HASH=<64-char-sha256>
export BTC_ALPHA_EXPECT_VERSION=7.16.0
export BTC_ALPHA_EVIDENCE_FILE=/absolute/path/to/evidence/bitcoin-only-all.json
export KEEPKEY_URL=http://localhost:1646
node tests/alpha/bitcoin-only-hardware.js all
```

Set `KEEPKEY_API_KEY` when reusing an existing pairing. Otherwise the SDK may
start a pairing approval.

The runner fails before wallet testing unless all three identities agree:

1. the supplied file hashes to the expected candidate hash;
2. the file embeds `KeepKeyBTC\0`;
3. the connected device reports the same hash and `firmware_variant` exactly
   `KeepKeyBTC`.

## What the runner proves

- Every non-Bitcoin address and signing endpoint returns HTTP 501 at Vault's
  REST boundary, including altcoin names passed through generic UTXO/xpub
  routes; the advertised coin list contains only Bitcoin networks.
- BIP44/P2PKH, BIP49/P2SH-P2WPKH, BIP84/P2WPKH, and BIP86/P2TR derive with the
  correct mainnet encoding.
- Each of those four addresses is shown on the physical OLED, compared
  character-for-character and by QR, and matches the non-display derivation.
- Legacy, nested SegWit, native SegWit, and Taproot sign offline synthetic
  transactions. The legacy case supplies a complete, structurally valid
  nonexistent previous transaction whose output belongs to the derived BIP44
  address.
- Vault and the device independently display the expected destination, amount,
  and fee.
- Device rejection propagates as a rejected SDK promise.
- The app presents the Bitcoin-only splash/navigation/portfolio/settings and
  stays restricted across disconnect/reconnect.

The Vault candidate also has executable host-boundary coverage beyond REST:

- every privileged renderer RPC is wrapped before dispatch; chain-specific
  prefixes, non-Bitcoin `chainId` values, generic UTXO coin names, xpub batches,
  ClearSign, swaps, and WalletConnect pairing fail before handler side effects;
- portfolio, history, report, mobile-pairing, audit, watch-only, cached-balance,
  and address-book reads are Bitcoin-scoped at their source;
- dynamic market/token requests and stale full-firmware ledger/report records
  are fenced while the Bitcoin-only device is connected;
- a full-firmware → Bitcoin-only transition resets in-memory account managers
  and removes persisted non-Bitcoin balances and xpubs;
- existing WalletConnect sessions are destroyed, queued deep links discarded,
  and each device-signing callback independently re-checks the live firmware
  variant while teardown is in progress;
- Zcash/Hive capability startup is disabled for Bitcoin-only firmware even when
  its semantic version would otherwise enable those services.

The synthetic prevouts do not exist, so signed transactions cannot be
broadcast. Evidence is written with mode `0600`, including the exact artifact,
firmware identity, addresses, serialized-transaction hashes, and operator
attestations. It contains no seed, private key, PIN, or passphrase.

## Manual in-app matrix still required

The runner exercises the production SDK/REST/hdwallet/device path, but it does
not prove the complete graphical send flow or backends. Use a funded disposable
test wallet and make an explicit spending decision before these cases:

| Mode | Receive/discovery | Build and review | Broadcast | Required observation |
|---|---|---|---|---|
| Pioneer | BIP44/49/84/86 accounts | Small P2WPKH and P2TR sends | One minimal-value transaction | Correct UTXO selection, change path, amount, fee, txid, and post-confirm balance |
| Self-hosted Blockbook | Same four accounts; next-unused indexes from Blockbook | Small P2WPKH and P2TR sends | One minimal-value transaction | No Pioneer chain-data fallback; Blockbook history and post-confirm balance agree |
| Self-hosted Bitcoin Core | Same four accounts; manually select/verify receive index | No-change/send-max build only | One minimal-value no-change transaction, if deliberately funded for it | No Pioneer chain-data fallback; Core UTXOs, fees, txid, and post-confirm balance agree; history and automatic change discovery are explicitly unavailable |
| Offline | Cached account plus manually selected/verified receive index | Device address derivation and raw/synthetic signing only | Build, history, sweep, swap, report, and broadcast must reject | No outbound sockets after airplane mode is enabled; cached balances remain readable and device address/signing still work |

Bitcoin Core's `scantxoutset` sees only the current UTXO set. It cannot prove
that an empty address was previously spent from, so it cannot safely choose the
next unused receive index or reconstruct transaction history. Vault must show
that limitation and must not consult Pioneer behind the node. Full self-hosted
history/index discovery requires Blockbook (or future descriptor-wallet import
and rescan support); a silent index-0 default is a test failure. A normal Core
send that would create change must fail before device signing rather than reuse
a guessed change address.

Also test RBF on a disposable transaction, high-fee rejection/warning, dust
handling, insufficient funds, cancellation at the Vault gate, cancellation on
the device, PIN-locked reconnect, passphrase account separation, and unplugging
during address display and signing.

The legacy P2PKH case must keep supplying the complete previous transaction.
Reducing it to only a txid/amount would bypass the legacy streaming path and is
not acceptable evidence, even if a future host shim made that request appear to
pass.

### Hot-transition regression (required once)

This catches state that a cold-start test cannot see:

1. On the same disposable device and seed, boot full firmware, load the
   portfolio, save one non-Bitcoin address-book row, and establish a disposable
   WalletConnect session.
2. Flash the exact Bitcoin-only candidate without restarting Vault.
3. Confirm Vault returns to the Bitcoin tab, closes WalletConnect, and the dApp
   session is disconnected rather than merely hidden.
4. Confirm no non-Bitcoin balance, xpub, activity, address-book row, swap,
   ClearSign, Zcash, Hive, Add Chain, or WalletConnect control remains visible.
5. Leave Vault idle through two portfolio refresh intervals and confirm the
   device receives no altcoin `Unknown message` probes.
6. Disconnect/reconnect and repeat the visibility and idle checks.
7. Return to full firmware and confirm full-firmware features return normally;
   this proves the restriction follows device identity rather than permanently
   corrupting the app's global preferences.

Record screenshots of the full-firmware before state and Bitcoin-only after
state, plus the dApp-side WalletConnect disconnect. Never use a production seed.

## Host verification already completed

- Bitcoin-only policy: 20 tests, including activity/ledger/report filtering and the
  renderer/REST dispatch boundaries.
- Bitcoin backend: Core 35 assertions, normalization 16, device-only 5.
- Taproot builder: P2TR input/change and BIP86 account-path selection, 3 cases.
- hdwallet Taproot: 8 tests, 28 assertions covering protocol enums, BIP86
  display/xpub requests, capability gating, and Schnorr input requirements.
- production Bun backend bundle and Vite renderer build both complete.

## Merge gate

Bitcoin-only alpha is not cleared until:

- the identity-fix CI matrix is green for its exact head;
- the Vault REST-boundary fix and its complete signing-route matrix test are
  present;
- the downloaded ARM artifact passes its CI identity assertion;
- `all` completes on physical hardware with preserved evidence;
- the in-app Pioneer, self-hosted, and offline matrix is recorded;
- a full firmware artifact on the same source head proves `KeepKeyBTC\0` is
  absent, preventing accidental Bitcoin-only branding of the normal build.
