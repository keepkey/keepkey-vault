# Alpha Bitcoin-only acceptance

Owner: BTC-only test lead  
Target: `alpha`, after the Bitcoin-only identity fix from firmware commit `80078493` is included  
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

Firmware commit `80078493` fixes physical identity and adds a CI assertion over
the actual flashable ARM artifact. Do not spend physical-device time on an
artifact that predates this commit or does not embed `KeepKeyBTC\0`.

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
- Nested SegWit, native SegWit, and Taproot sign offline synthetic transactions.
- Vault and the device independently display the expected destination, amount,
  and fee.
- Device rejection propagates as a rejected SDK promise.
- The app presents the Bitcoin-only splash/navigation/portfolio/settings and
  stays restricted across disconnect/reconnect.

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
| Self-hosted Bitcoin Core | Same four accounts | Small P2WPKH send | One minimal-value transaction | No Pioneer fallback; node health and history agree with Core |
| Offline | Cached account plus receive | Build/sign imported or prepared transaction | Must remain disabled | No balance/history/broadcast network traffic; address and device signing still work |

Also test RBF on a disposable transaction, high-fee rejection/warning, dust
handling, insufficient funds, cancellation at the Vault gate, cancellation on
the device, PIN-locked reconnect, passphrase account separation, and unplugging
during address display and signing.

Legacy P2PKH signing is intentionally not faked by the runner: firmware requires
the full previous transaction for a legacy input. Cover it with a real funded
test UTXO or add a structurally valid offline previous-transaction fixture. Do
not weaken that requirement merely to make a synthetic test pass.

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
