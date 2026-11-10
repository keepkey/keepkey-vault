# Vault screens — November 10, 2026

A screenshot set covering every main Vault flow, for UX review. Screens that need a live device are listed at the end. Taken from `origin/develop` at `cb5b8f98` (v1.6.11) in the Vite UI with a mocked Electrobun RPC bridge, at 1280×800, JPEG. Data is fake: two saved wallets (Midas, Cannabis), ten funded chains and dummy addresses.

**How to reach** uses the mock's scenario (`?s=`), then the clicks, DOM events or backend messages that open the screen. In the real app the same screens come from the device state shown in the scenario name.

**UI issue** is a one-line observation from the screenshot, not a confirmed bug. Mock artifacts (empty swap quotes, "No chains available", "Unknown route", missing per-address EVM balances) are left out.

68 screens.


## Wallet chooser

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Connect your KeepKey (no saved wallets)](01-wallet-chooser/chooser-empty.jpg) | `?s=empty` | — |
| [Choose a wallet (saved wallets + emulator)](01-wallet-chooser/chooser-with-wallets.jpg) | `?s=chooser` | — |
| [Emulator seed picker](01-wallet-chooser/emulator-seed-picker.jpg) | `?s=chooser` → click **Start emulator** | — |
| [Import watch-only wallet dialog](01-wallet-chooser/import-watch-only.jpg) | `?s=chooser` → event `keepkey-watch-only-import` | — |
| [Sign Bitcoin PSBT dialog](01-wallet-chooser/psbt-paste.jpg) | `?s=chooser` → event `keepkey-psbt-paste` | — |
| [Scan Bitcoin QR overlay](01-wallet-chooser/scan-bitcoin-qr.jpg) | `?s=chooser` → event `keepkey-bitcoin-qr-scan` | Overlay has no card or panel: title, error and buttons float directly over the dimmed chooser. |
| [View-only portfolio (opened from a saved wallet)](01-wallet-chooser/watch-only-portfolio.jpg) | `?s=chooser` → click **Open view-only** | — |

## Device states (splash)

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Device error](02-device-states/error.jpg) | `?s=error` | Status pill shows the raw libusb code ("Error: LIBUSB_ERROR_ACCESS") rather than a plain-language reason. |
| [Passphrase required](02-device-states/passphrase.jpg) | `?s=needs_passphrase` → backend message `passphrase-request` | — |
| [PIN entry](02-device-states/pin-entry.jpg) | `?s=needs_pin` → backend message `pin-request` | — |
| [Device connected, not paired](02-device-states/unpaired.jpg) | `?s=unpaired` | — |

## Onboarding / setup

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Hidden wallets (passphrase) intro](03-onboarding/passphrase-intro.jpg) | `?s=ready_intro` | Only purple primary CTA in the app ("Got it"); every other primary action is gold. |
| [Recovery: word entry (cipher)](03-onboarding/recovery-word-entry.jpg) | `?s=needs_init` → backend message `character-request` | — |
| [Setup wizard: bootloader mode](03-onboarding/setup-bootloader.jpg) | `?s=bootloader` | — |
| [Setup wizard: firmware update needed](03-onboarding/setup-needs-firmware.jpg) | `?s=needs_firmware` | "Signature check" body text wraps at half the card width, leaving an empty right column. |
| [Setup wizard (new device)](03-onboarding/setup-needs-init.jpg) | `?s=needs_init` | Wizard title and progress bar are green while every other primary accent is gold. |

## Dashboard

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Activity panel](04-dashboard/activity.jpg) | `?s=ready` → click **⚡ Activity** | — |
| [Add network dialog](04-dashboard/add-network.jpg) | `?s=ready` → click **+ Add network** | Pagination ("Prev · Next") still renders when the list is empty. |
| [Address book: add address](04-dashboard/address-book-add.jpg) | `?s=ready` → click **Addresses** → click **Add Address** | — |
| [Addresses tab](04-dashboard/addresses.jpg) | `?s=ready` → click **Addresses** | — |
| [Dashboard: all chains](04-dashboard/all-chains.jpg) | `?s=ready` | — |
| [Dashboard with every feature flag on](04-dashboard/all-chains-all-features.jpg) | `?s=features` | — |
| [Audit](04-dashboard/audit.jpg) | `?s=ready` → click **Audit** | — |
| [Explore tab](04-dashboard/explore.jpg) | `?s=ready` → click **Explore** | — |
| [Mobile app pairing](04-dashboard/mobile-app.jpg) | `?s=ready` → click **Mobile App** | — |
| [Dashboard: offline banner](04-dashboard/offline.jpg) | `?s=offline` | — |
| [Reports](04-dashboard/reports.jpg) | `?s=ready` → click **Reports** | Body copy in the tinted box is ~11px, much smaller than the title and the rest of the app's dialog text. |
| [ShapeShift tab](04-dashboard/shapeshift.jpg) | `?s=ready` → click **ShapeShift** | — |

## Asset page: UTXO

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Bitcoin](05-asset-utxo/bitcoin.jpg) | `?s=ready` → click **Bitcoin** | — |
| [Bitcoin Cash (zero balance)](05-asset-utxo/bitcoincash-empty.jpg) | `?s=ready` → click **BitcoinCash** | — |
| [Dogecoin](05-asset-utxo/dogecoin.jpg) | `?s=ready` → click **Dogecoin** | Doge easter-egg sticker covers the Activity button in the bottom-right corner. |
| [Litecoin](05-asset-utxo/litecoin.jpg) | `?s=ready` → click **Litecoin** | — |

## Asset page: EVM

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Base](05-asset-evm/base.jpg) | `?s=ready` → click **Base** | — |
| [Ethereum (with a token)](05-asset-evm/ethereum.jpg) | `?s=ready` → click **Ethereum** | — |
| [Polygon (zero balance)](05-asset-evm/polygon-empty.jpg) | `?s=ready` → click **Polygon** | — |

## Asset page: Cosmos

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Cosmos](05-asset-cosmos/cosmos.jpg) | `?s=ready` → click **Cosmos** | — |
| [Osmosis (zero balance)](05-asset-cosmos/osmosis-empty.jpg) | `?s=ready` → click **Osmosis** | — |
| [THORChain](05-asset-cosmos/thorchain.jpg) | `?s=ready` → click **THORChain** | — |

## Asset page: Solana, XRP, Tron, TON

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Ripple](05-asset-other/ripple.jpg) | `?s=ready` → click **Ripple** | — |
| [Solana](05-asset-other/solana.jpg) | `?s=ready` → click **Solana** | — |
| [TON (zero balance)](05-asset-other/ton-empty.jpg) | `?s=ready` → click **Ton** | — |
| [Tron](05-asset-other/tron.jpg) | `?s=ready` → click **Tron** | — |

## Receive

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Receive BTC](06-receive/bitcoin.jpg) | `?s=ready` → click **Bitcoin** → click **Receive** | Script-type cards truncate addresses to "bc1..." / "3..." / "1...", which tells the user nothing; cards are shorter than the Receive/Send/Swap pill next to them. |
| [Receive ATOM](06-receive/cosmos.jpg) | `?s=ready` → click **Cosmos** → click **Receive** | — |
| [Receive ETH](06-receive/ethereum.jpg) | `?s=ready` → click **Ethereum** → click **Receive** | — |
| [Receive SOL](06-receive/solana.jpg) | `?s=ready` → click **Solana** → click **Receive** | — |

## Send

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Send BTC](07-send/bitcoin.jpg) | `?s=ready` → click **Bitcoin** → click **Send** | — |
| [Send ATOM](07-send/cosmos.jpg) | `?s=ready` → click **Cosmos** → click **Send** | — |
| [Send ETH](07-send/ethereum.jpg) | `?s=ready` → click **Ethereum** → click **Send** | — |
| [Send XRP](07-send/ripple.jpg) | `?s=ready` → click **Ripple** → click **Send** | — |

## Swap

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Swap from BTC](08-swap/bitcoin.jpg) | `?s=ready` → click **Bitcoin** → click **Swap** | Native assets carry a "GAS" badge on both sides of the swap; reads like a warning rather than "native coin". |
| [Swap from ETH](08-swap/ethereum.jpg) | `?s=ready` → click **Ethereum** → click **Swap** | — |

## Settings

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Settings: Advanced](09-settings/advanced.jpg) | `?s=ready` → click **Device settings** → click **Advanced** | — |
| [Settings: Connections](09-settings/connections.jpg) | `?s=ready` → click **Device settings** → click **Connections** | "Pair Mobile" button wraps onto two lines inside its pill. |
| [Settings: Device](09-settings/device.jpg) | `?s=ready` → click **Device settings** → click **Device** | — |
| [Settings: Device (firmware up to date, fw 7.17)](09-settings/device-firmware-current.jpg) | `?s=features` → click **Device settings** → click **Device** | — |
| [Settings: Feature flags](09-settings/feature-flags.jpg) | `?s=ready` → click **Device settings** → click **Feature Flags** | Divider lines appear only between the first three rows; the remaining flags have none. |
| [Settings: General](09-settings/general.jpg) | `?s=ready` → click **Device settings** | Settings drawer uses a sans-serif font; the rest of the app is Geist Mono. |
| [Settings: Networks](09-settings/networks.jpg) | `?s=ready` → click **Device settings** → click **Networks** | — |
| [Settings: Security](09-settings/security.jpg) | `?s=ready` → click **Device settings** → click **Security** | Row icon column is inconsistent (Auto-lock text starts further left); Verify Seed's word-count chips sit outside the row grid; Auto-lock select is gold text unlike other controls. |

## Firmware

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Setup wizard: firmware update step (after Continue to update)](10-firmware/update-in-progress.jpg) | `?s=needs_firmware` → click **Continue to update** | — |

## Zcash

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Zcash asset page](11-zcash/zcash.jpg) | `?s=features` → click **Zcash** | Only Receive/Send/Swap on the asset page; no visible entry to the shielded view in this state. |

## Monero

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Monero asset page](12-monero/monero.jpg) | `?s=features` → click **Monero** | Shows a "Confirm on KeepKey" wait state as soon as the page opens. |

## Hive

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Hive asset page](13-hive/hive.jpg) | `?s=features` → click **Hive** | — |

## Passwords

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [Password bank](14-passwords/passwords.jpg) | `?s=features` → click **Passwords** | — |

## Approvals and dialogs

| Screen | How to reach | UI issue |
| --- | --- | --- |
| [App pairing request (REST API client)](15-approvals/pairing-request.jpg) | `?s=ready` → backend message `pair-request` | — |
| [Signing approval: ETH transaction](15-approvals/signing-eth-transaction.jpg) | `?s=ready` → backend message `signing-request` | Value is shown as raw hex wei (0x16345785d8a0000), not 0.1 ETH; chain is shown upper-case (ETHEREUM). |
| [Signing approval: personal_sign message](15-approvals/signing-personal-sign.jpg) | `?s=ready` → backend message `signing-request` | Message is shown as hex only by default; the decoded UTF-8 text is one click away. |

## Not rendered (needs a live device or backend)

These screens depend on device round-trips or backend data the mock cannot produce faithfully:

- Send and swap review/confirmation after **Build Transaction** or **Review Swap** (needs real fee, nonce and quote data), and the broadcast/txid result screens.
- On-device confirmation overlays during signing ("Confirm on your KeepKey"), PIN change, wipe and label change.
- Firmware and bootloader flashing progress, reboot and completion (driven by device events).
- New-wallet creation: backup-word display and verification steps.
- Zcash shielded (Orchard) send and the privacy tab, Monero send and sync-complete states, Hive account operations.
- PSBT review after parsing a real PSBT, multisig co-signing and Safe flows, WalletConnect session approval.
- Clear-sign report cards for decoded calldata, typed data and Solana instructions (need real decoder output).
- Password bank unlock/rotation prompts that wait on the device.
- Emulator running state (needs the emulator process).
- Settings › Monero tab: not present in this build even with Monero enabled.

## Reproducing

The harness is not committed: a Playwright script, a mock bridge with per-scenario fixtures, and RPC defaults generated
from `src/shared/rpc-schema.ts`. Ask in the PR if you want it added under `scripts/qa/`.
