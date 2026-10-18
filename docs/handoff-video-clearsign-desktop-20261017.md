# Handoff for the video agent: ClearSign in KeepKey Desktop (2026-10-17)

The customer-facing name is **KeepKey Desktop** (never "Vault"). Product claims must match
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-docs-v8/internal/PRODUCT_TRUTH.md`.

## Status: not released yet

- **Where it is:** everything below is on the `develop` branch of keepkey/keepkey-vault (local checkout
  `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11`). The released KeepKey Desktop 1.6.3
  (pre-release, 2026-10-17) does **not** include it.
- **What not to say:** don't call it shipped or available. Safe wording is "coming to KeepKey Desktop". Commit links
  on GitHub are fine.
- **Firmware:** the device side needs KeepKey firmware **7.16.0**.

## The feature in one line

Before you sign, KeepKey Desktop tells you in plain words what a transaction does. Your KeepKey shows the same
description on its own screen, from a description KeepKey has signed. Signing blind becomes the exception.

## What the viewer sees (real examples from hardware testing today)

### 1. A described contract call (Aave supply on Ethereum)
- **Desktop approval card:**
  - **"Aave V3 · Supply"**, then one line on what supplying does.
  - "Amount to supply: 0.000001 USDC" and "Collateral recipient: 0x909E… (this wallet)".
  - Links to aave.com and Etherscan.
  - The card says the description is **Signed by KeepKey ClearSign**.
- **On the KeepKey:** a "Supply" review with the same fields, built from the same signed ERC-7730 description.
  Advanced Mode stays off, and there are no raw-hex pages.
- **Where the description comes from:** the Ethereum Foundation's ERC-7730 registry, checked and signed by KeepKey,
  then served to Desktop by KeepKey's ClearSign service.

### 2. A contract KeepKey hasn't reviewed (Venice staking `claimAndStake` on Base)
- **Desktop card:** one calm line, "Used before, but your KeepKey cannot show this call", plus the contract's own
  name ("Staked Venice Token", marked not verified) and "You have used this contract … at least 2 times before".
- **No alarm walls.** A contract you have never used stays red.
- **Review button:** a **Submit to KeepKey for review** button with the KeepKey logo. Hovering it explains:
  "KeepKey reviews ClearSign submissions for third-party contracts…".

### 3. Certified address book (contacts)
- **Setup, in Address Book:**
  1. Turn on ClearSign.
  2. Press **Certify contacts**.
  3. A colourful review box lists every contact (name, network logo, address). An **X** leaves a contact out.
  4. **Certify on KeepKey** has the device sign the list.
- **Result:** sends to a certified contact from Desktop's Send page show the **contact's name on the KeepKey
  screen**, with the full address still shown.
- **Ordering:** Address Book opens on Saved recipients, most recently sent-to first.

### 4. Transaction history
- **Details section:** Transaction details shows the action ("Uniswap Universal Router · Swap"), what moved
  ("Sent 100 USDC", "Received 0.04125 WETH"), Succeeded/Failed, and how you signed it ("Shown on your KeepKey",
  "Requested by KeepKey Browser Extension").
- **What it leaves out:** warnings and addresses.

## Claims to avoid

- Don't say every transaction is clear-signed: unknown contracts still need Advanced Mode on the device.
- Don't say ERC-7730 typed-data (EIP-712) signing is on. It is off on 7.16; only calldata is.
- Don't say contacts work for browser-extension or WalletConnect requests. Only Desktop's own Send page, plain
  sends, EVM only, up to 16 contacts.
- A certified contact can't be revoked. Recertifying a new list is how a contact is dropped.

## Demo setup

- **Desktop:** run with `make vault` from the repo root on `develop`.
- **Device:** a KeepKey on signed firmware 7.16.0, with Advanced Mode off. Unplug and replug clears it.
- **Card 1:** the SDK suite `make test-sdk filter=fw-716/40-` (Aave supply). It signs only and never broadcasts. Or
  use app.aave.com through the KeepKey Browser Extension and reject at the end.
- **Screenshots:** the owner's are in `/Users/highlander/Documents/content/screenshots/`.

## Where the code is, and the author

- **Repo:** keepkey/keepkey-vault (`https://github.com/keepkey/keepkey-vault`), app code in `projects/keepkey-vault/`.
- **Author:** every commit is GPG-signed by **highlander <highlander@keepkey.com>** (GitHub: BitHighlander). There
  is no AI co-author on any of them.
- **Commits, oldest first, on `develop`:**
  - `2670ec4e7`, `d366aa810`: the unknown-contract card says what Desktop knows.
  - `934ee8dd1`, `30f09482d`: the review button with the KeepKey logo and the hover text.
  - `dad0913ef`, `022ebb0c8`, `61cbff00a`, `dab19a571`: the Details section in transaction details.
  - `9d53cb1a1`, `1c02e9433`: SDK hardware suites 41–43.
  - `8e68dff73`, `4e1d50743`: the approval card renders the signed ERC-7730 description ("Aave V3 · Supply").
  - `bdd41fa04`, `4adfb3bbc`, `60267787d`: the address book certify review and ordering.
- **Key files** (under `projects/keepkey-vault/src/`):
  - `bun/erc7730-describe.ts`: reads the signed ERC-7730 program and renders the lines the KeepKey shows.
  - `mainview/components/device/SigningApproval.tsx`, `mainview/components/ClearSignReportCard.tsx`,
    `shared/clearsign-risk.ts`: the approval card.
  - `bun/contract-facts.ts`: contract name and prior use.
  - `bun/signed-tx-review.ts`, `shared/tx-clearsign.ts`, `mainview/components/ActivityPanel.tsx`: transaction
    details.
  - `bun/addressbook-clearsign.ts`, `mainview/components/AddressBookView.tsx`: the certified address book.
- **SDK suites:** `projects/keepkey-sdk/tests/fw-716/40-erc7730-sign.js` through `43-erc7730-aave-lido.js`.
- **Firmware:** the KeepKey side of ERC-7730 and certified contacts is firmware 7.16.0
  (`modules/keepkey-firmware`, `fsm_msg_ethereum.h`, `erc7730_catalog.c`).
