# KeepKey vs Trezor vs Ledger: how each handles the 12 big design decisions

Research date: 2026-10-04. KeepKey facts come from the local 7.16 tree at `/Users/highlander/keepkey-toolchain/fw716-fix` (cited as `fw716-fix/...`) and from `keepkey-vault/clearsign-worker/README.md`. Trezor facts come from `trezor/trezor-firmware@main` (fetched 2026-10-04) and trezor.io. Ledger facts come from `LedgerHQ/app-ethereum@master`, `LedgerHQ/app-security-key`, developers.ledger.com and support.ledger.com.

Tags: **[unverified]** means I could not confirm the claim in a primary source. **[secondary]** means the only source is press, a forum or a third-party blog.

---

## Executive summary

| # | Decision | Verdict |
|---|---|---|
| 1 | Blind-signing policy | **Aligned with Ledger, stricter than Trezor.** Ledger also uses an off-by-default setting, but it persists until the next app or OS update. KeepKey's AdvancedMode clears at every boot and lock, which makes it the strictest of the three. Trezor has no setting at all: unknown data falls back to hex pages behind a warning. |
| 2 | Clear-signing metadata | **Same architecture as both, different trust root.** All three now have the host stream signed metadata and the device decode the real values. Trezor signs a Merkle root with CoSi Ed25519 keys (3 keys, 1 signature required since format v2). Ledger's CAL signs per-contract TLV records. KeepKey's offline root → per-chain delegate chain is the only design with built-in delegate expiry. |
| 3 | ERC-20 table in firmware | **Now on Trezor's model, 3.5 years later.** Trezor moved tokens and networks to signed host definitions in core 2.6.0 (Apr 2023) and on the T1 in 1.13.0 (Feb 2025). Ledger never shipped a large table: the CAL signs per-token records. KeepKey cut its table to stablecoins plus the tokens its coin table needs on 4 Oct; everything else comes from signed metadata. |
| 4 | Uniswap / Permit2 | **Diverging on purpose.** Ledger decodes Uniswap on the device with a plugin (Universal Router v2/v3 commands plus Permit2; no V4, no split mixed-version paths). Trezor added "select Uniswap swap functions" in 2.11.1 (Apr 2026). KeepKey keeps the device decoding (D-018): its on-device decoder (0x07) is restored with the clean-up step and split routes, and V4's common shapes are being added for 7.16 (D-019). (An interim plan for server-written per-transaction descriptions, D-009, was superseded.) |
| 5 | EIP-712 | **Aligned with Trezor T/Safe and Ledger; ahead of the Trezor One.** All three stream the full typed data on modern devices. The Trezor One is hash-only (blind). Ledger adds signed filtering. |
| 6 | Unlimited approvals | **Outlier, and inconsistent internally.** Trezor and Ledger show "Unlimited" and let the user sign. KeepKey shows `approve()` as UNLIMITED and lets it through, but refuses unlimited EIP-2612/DAI permits outright (Permit2 is the exception). |
| 7 | Flash on the oldest model | **Ahead.** On the same 1 MB MCU class, Trezor dropped coins from the One, kept it hash-only for EIP-712, and left it out of clear signing. Ledger ended Nano S software support in 2025 over its 320 KB limit. KeepKey still ships streaming EIP-712, clear-sign v2 and Orchard on the F205. |
| 8 | Firmware variants / privacy coins | **Aligned on btc-only, ahead on Zcash.** Trezor ships signed btc-only images for every model and Ledger has none. Neither Trezor nor Ledger's own app signs Orchard. Ledger's new native app (Sep 2026) supports only the Ironwood pool [secondary]. |
| 9 | FIDO2 / passkeys | **Aligned with Trezor, ahead of Ledger on resident keys.** Trezor T/Safe has had FIDO2 since 2019 (the One is U2F only). Ledger's Security Key app has resident keys disabled. KeepKey has U2F plus CTAP2 in firmware; host reachability is unverified. |
| 10 | PIN / auto-lock / wipe code / passphrase | **Mostly aligned with Trezor. Outlier on PIN-failure wipe.** KeepKey uses exponential delay only. Trezor wipes after 16 failures (10 on the Safe 7); Ledger wipes after 3. The 10-minute auto-lock default matches Trezor. KeepKey's "only user or workflow progress renews the idle timer" rule matches Trezor's 2.6.0 change. |
| 11 | Firmware signing / release | **Aligned with the Trezor One** (3 signatures from a 5-key set, storage wipe on unsigned firmware, hash-confirm warning). Behind Trezor on reproducible builds (theirs are Docker/Nix, one command) and on vendor-header trust levels. |
| 12 | Authenticity / RNG / dice | **Ahead on user-verifiable entropy, behind on device authenticity.** Neither Trezor nor Ledger offers dice. Trezor added a host-side entropy-check protocol (2025). Trezor Safe and Ledger use secure-element attestation, which a STM32F205 KeepKey cannot do. |

---

## 1. Blind-signing policy

| | KeepKey 7.15 / 7.16 | Trezor (T1 / T / Safe) | Ledger (Ethereum app) |
|---|---|---|---|
| Unknown calldata | Refused unless AdvancedMode is on. With it on, the raw data is reviewed. | Always signable. Hex pages ("Transaction data:" 3×8 bytes per page) on the T1; data chunks plus a warning on core. Never refused. | Refused while the "Blind signing" setting is off; the app shows a warning that redirects the user to enable it. |
| Setting | AdvancedMode policy, **session-only**: cleared at boot and lock | None | "Blind signing" in app settings |
| Default | Off | n/a | Off ("must be off by default", Ledger guidelines) |
| Persistence | Cleared on every boot or lock | n/a | Persists; auto-disabled after an OS or Ethereum-app update [secondary: support-article snippet] |
| Certified path | 7.16: KeepKey-certified descriptions remove the AdvancedMode requirement | 2.12.4+: ERC-7730 descriptors clear-sign; unknown contracts "fall back to standard blind signing (hash / 'Data Present') with the usual warning" | ERC-7730 / plugins clear-sign; a warning still appears on every blind tx when the setting is on |

Notes:
- **Trezor's model is "warn, don't refuse."** The T1 pages through calldata and, past `MAX_DATA_PAGES`, shows "Warning! Too long data to view. Proceed with caution." (`legacy/firmware/ethereum.c`). Core falls back to `_confirm_data_chunks` whenever `clear_signing.try_confirm` fails (`core/src/apps/ethereum/sign_tx.py`). There is no user-facing gate.
- Ledger's setting dates from app 1.9.5 (Sep 2021, as "Contract data" → "Blind sign"). It was reworked in 1.11.0 and 1.11.2 (Jul/Aug 2024: per-transaction warning flow, "Blind-signing setting"). 1.14.0 (Dec 2024) added the tx hash to the blind flow.
- Ledger's changelog shows that **gates get bypassed**. 1.22.0 (Apr 2026) fixed a "Blind-signing bypass for single-byte calldata `0x00`" and a "bypass with EIP-712 filtering activation". 1.22.3 (Aug 2026) fixed "Standard swap flow could skip calldata validation when blind signing was enabled". This is direct prior art for fuzzing KeepKey's AdvancedMode gate edges.
- KeepKey's session-only toggle is stricter than either peer. No peer resets the setting on lock. Ledger's reset happens only on update.

Sources: [Ledger design guidelines: transactions](https://developers.ledger.com/docs/device-app/integration/design-guidelines/transactions) · [Ledger support: Ethereum](https://support.ledger.com/article/360009576554-zd) · [app-ethereum CHANGELOG](https://github.com/LedgerHQ/app-ethereum/blob/master/CHANGELOG.md) · [trezor legacy ethereum.c](https://github.com/trezor/trezor-firmware/blob/main/legacy/firmware/ethereum.c) · [trezor core sign_tx.py](https://github.com/trezor/trezor-firmware/blob/main/core/src/apps/ethereum/sign_tx.py) · [Clear Signing on Trezor guide](https://trezor.io/guides/sending-receiving-staking-funds/interacting-with-smart-contracts/clear-signing-on-trezor) · KeepKey: `fw716-fix/lib/firmware/storage.c` (AdvancedMode policy), `fw716-fix/lib/firmware/erc7730_catalog.c`

---

## 2. Clear-signing metadata architecture

| | KeepKey 7.16 | Trezor (core 2.12.x) | Ledger |
|---|---|---|---|
| Format | Own schema (v1: per-tx description bound to tx hash; v2/v5: reusable shape, device decodes the args) | ERC-7730 compiled to an `EthereumDisplayFormatInfo` protobuf, delivered as `EthereumDefinitions.encoded_display_format` | ERC-7730 compiled by CAL into TLV `TRANSACTION_INFO` + `FIELD` structs ("generic parser") **plus** legacy plugins |
| Who authors | KeepKey reviews each transaction shape | Protocols, in the EF-governed ERC-7730 registry; Trezor verifies | Protocols, in the same registry; Ledger reviews |
| Who signs | Delegate key on a Cloudflare Worker; the delegate is certified per chain by an offline root KeepKey | Trezor: a Merkle tree over all definitions, root signed by **CoSi Ed25519, 3 production keys, threshold 1** (format v2) | Ledger CAL (secp256k1); key selected via `SIG_KEY_ID`; app built with `ENABLE_PKI_LIBRARY` (Ledger-PKI certificates) |
| Device verifies | cert → description → exact tx shape; values decoded from the real calldata | Merkle proof + CoSi sig + `data_version ≥ MIN_DATA_VERSION`; then decodes calldata | `TRANSACTION_INFO` signature (includes `FIELDS_HASH` = SHA3 over all FIELD structs, chain, contract, selector); then decodes calldata |
| Expiry / revocation | Per-chain cert expiry (2026-12-31); firmware can raise the minimum | Freshness floor only: "will only accept signed definitions newer than a certain date, typically one month before firmware release". No per-item revocation. | Trusted-name TLV has `NOT_VALID_AFTER` (= an **app version**) and an optional `CHALLENGE` nonce. TX-info has no expiry field. |
| Unknown | Normal review (AdvancedMode gate) | Blind-sign fallback with warning | Blind-sign gate |

Notes:
- **Trezor reused one signed-definition container for everything.** The `trzd` magic, format version, `DefinitionType` (0 network, 1 token, 2 Solana token, **3 Ethereum display format**), a 4-byte `data_version`, then protobuf, Merkle proof, CoSi sigmask and 64-byte sig. Display formats ride the same pipeline and keys as tokens (`core/src/apps/common/definitions.py`; `messages-definitions.proto`).
- The Trezor production keys are three Ed25519 keys in `core/embed/rust/src/definitions/constants.rs`. `DefsVersion::V1` needs 2 signatures and `V2` needs 1. The T1 "accepts only format version 2 since version 1.14.2", so Trezor *lowered* the threshold to 1-of-3 for operational reasons.
- Trezor issue #6733 states the design: "The host application (Trezor Suite/Connect) should be responsible for resolving the appropriate descriptor and passing it to the device", and "descriptors must be cryptographically signed by Trezor company". Clear signing is in 2.12.4+ on T/Safe 3/5/7 and is **not on the Trezor One**.
- **Ledger's FIELDS_HASH trick matches KeepKey v2.** One signed header commits to an ordered list of unsigned field descriptors, so the descriptors are reusable per (chain, contract, selector) and the device fills in the values. Ledger plugins (`SET PLUGIN`) are a separate, older path: a signed binding of (plugin name, address, selector, chainId) to a plugin app installed on the device.
- ERC-7730's own security section says a wallet "MUST ensure formatting is cryptographically bound to the reviewed data", and that a registry "should require cryptographically verifiable provenance … multi-party sign-off … revocations". KeepKey's root → delegate chain with expiry is closer to that wording than Trezor's 1-of-3 floor-only model.
- Privacy: Trezor fetches definitions by static URL (`data.trezor.io/firmware/definitions/eth/chain-id/<id>/token-<addr>.dat`) and offers the whole set as a tarball, so the host can avoid per-tx lookups. KeepKey's worker receives chain, contract, selector and length (plus the spender on approvals, and token addresses on swaps).

Sources: [Trezor external definitions doc](https://github.com/trezor/trezor-firmware/blob/main/docs/common/external-definitions.md) · [definitions constants.rs](https://github.com/trezor/trezor-firmware/blob/main/core/embed/rust/src/definitions/constants.rs) · [messages-definitions.proto](https://github.com/trezor/trezor-firmware/blob/main/common/protob/messages-definitions.proto) · [messages-ethereum.proto](https://github.com/trezor/trezor-firmware/blob/main/common/protob/messages-ethereum.proto) · [trezor #6733](https://github.com/trezor/trezor-firmware/issues/6733) · [Trezor clear-signing blog, 2026-09-07](https://trezor.io/blog/news/clear-signing-comes-to-trezor-our-flagship-security-feature-of-2026) · [app-ethereum ethapp.adoc](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/ethapp.adoc) · [tlv_structs.md](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/tlv_structs.md) · [gcs.md](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/gcs.md) · [Ledger clear-signing overview](https://developers.ledger.com/docs/clear-signing/overview) · [ERC-7730 spec](https://github.com/ethereum/clear-signing-erc7730-registry/blob/master/specs/erc-7730.md) · KeepKey: `clearsign-worker/README.md`

---

## 3. ERC-20 token table in firmware

| | KeepKey | Trezor | Ledger |
|---|---|---|---|
| Built-in | Stablecoins plus the tokens the coin table needs (96 rows, from 1,945 in July); 0 tokens in the btc-only image. | Small built-in subset (`common/defs/ethereum/tokens.json`, `networks.json`); "These definitions need to be modified manually" | Effectively none for display. The Ethereum app relies on host-provided records. |
| Off-device | 7.16 signed metadata / name records | Signed `trzd` token + network blobs: core **2.6.0 (19 Apr 2023)**, T1 **1.13.0 (19 Feb 2025)** | `PROVIDE ERC 20 TOKEN INFORMATION`: sig over `ticker‖address‖decimals‖chainId`, single secp256k1 CAL key printed in the spec |
| Unknown token | — | Approve/transfer go ahead with an "unknown token" warning and the contract address | ERC-20 plugin needs the token record; without it the app falls back to the blind flow [unverified, inferred from changelog entry "Blind-signing of ERC-20 transfer/approve not working"] |

Notes:
- Trezor's split is "built-in for the most common, signed external for the rest", and built-ins win when both exist (`core/src/apps/ethereum/definitions.py`). This is the exact model KeepKey is moving to.
- Trezor's freshness floor is generated from `common/defs/ethereum/released-definitions-timestamp.json` (today: v1 `2026-07-31`, v2 `2026-08-31`). On the T1 it is compiled in as `MIN_DATA_VERSION` (`legacy/firmware/ethereum_definitions_constants.h.mako`). A stale host therefore fails closed after a firmware update, and the doc says clients must "always fetch fresh definitions … or refresh … frequently".
- Ledger's legacy token APDU has no expiry and no key rotation in the payload. Its newer TLV records add `SIG_KEY_ID` / `SIG_ALGO`.

Sources: [Trezor external definitions](https://github.com/trezor/trezor-firmware/blob/main/docs/common/external-definitions.md) · [core CHANGELOG.T2T1](https://github.com/trezor/trezor-firmware/blob/main/core/CHANGELOG.T2T1.md) · [legacy CHANGELOG](https://github.com/trezor/trezor-firmware/blob/main/legacy/firmware/CHANGELOG.md) · [legacy ethereum_definitions.c](https://github.com/trezor/trezor-firmware/blob/main/legacy/firmware/ethereum_definitions.c) · [MetaMask thread on the Trezor definitions breaking change](https://community.metamask.io/t/trezor-breaking-change-ethereum-definitions-networks-and-tokens/23622) · [ethapp.adoc §PROVIDE ERC 20 TOKEN INFORMATION](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/ethapp.adoc)

---

## 4. Uniswap / DEX swaps and Permit2

| | KeepKey 7.16 | Trezor | Ledger |
|---|---|---|---|
| Universal Router `execute` | On-device decoder (0x07, `uniswap_ur.c`) restored under D-018: V2/V3, wrap/unwrap, sweep, pay-portion, clean-up step, split routes; V4 common shapes planned for 7.16 (D-019). Decodes the whole calldata up to 1,472 bytes. | "Clear signing support for select swap functions from Uniswap" (2.11.1, 22 Apr 2026); decoded via host-supplied display formats [mechanism for UR commands unverified] | `app-plugin-uniswap`: UR v2.0 `0x3593564c`, commands V2/V3 swap in/out, WRAP/UNWRAP_ETH, PERMIT2_PERMIT(_BATCH), TRANSFER_FROM_BATCH, PAY_PORTION |
| Limits | The description is the service's words; any ETH sent is still shown by the device | — | "Due to memory space limitations" a swap with a split path across versions cannot be signed; no V4 commands listed |
| `approve(Permit2)` | Schema pins the Permit2 address: "Let the Uniswap approval contract spend up to {amount}…" | Approve flow (2.9.0) with spender and amount | ERC-20 plugin |
| Permit2 EIP-712 | Canonical Permit2 captured and described in words (`eip712_stream.c`) | Full EIP-712 display; ERC-7730 for messages | EIP-712 filtering from CAL; registry has Permit2 descriptors |

Notes:
- Ledger shipped Uniswap swaps inside Ledger Wallet through the Uniswap API, with clear signing (Uniswap case study; Jan 2025 announcement). Its plugin is still maintained (last push 2026-07-16).
- Both Ledger and KeepKey hit the same wall: UR command streams are too large or varied for small devices, so both decode a subset and refuse or blind-sign the rest. ERC-7730 v1 cannot express UR's `commands`/`inputs` byte-array interpreter, which is why Ledger kept a plugin [inference].

Sources: [app-plugin-uniswap spec](https://github.com/LedgerHQ/app-plugin-uniswap/blob/develop/PLUGIN_SPECIFICATION.md) · [Uniswap × Ledger case study](https://blog.uniswap.org/ledger-case-study) · [core CHANGELOG.T2T1 2.11.1](https://github.com/trezor/trezor-firmware/blob/main/core/CHANGELOG.T2T1.md) · [ERC-7730 spec (Permit2 binding example)](https://github.com/ethereum/clear-signing-erc7730-registry/blob/master/specs/erc-7730.md) · KeepKey: `clearsign-worker/README.md`, `fw716-fix/lib/firmware/eip712_stream.c`

---

## 5. EIP-712 typed data

| | KeepKey | Trezor One | Trezor T / Safe | Ledger |
|---|---|---|---|---|
| Mode | Streamed struct/value (`eip712_stream.c`); legacy JSON path (`eip712.c`) | **Hash only** (`EthereumSignTypedHash`): domain and message hashes, effectively blind ("Support for blindly signing EIP-712 data") | Full streaming since 2.4.3 (Dec 2021) via `EthereumTypedDataStructRequest` / `ValueRequest`; optional `show_message_hash` (2.9.1); cached domain (2.12.0) | v0 hash mode (app 1.5.0); full on-device JSON hashing since 1.9.19; signed **EIP-712 filtering** (field selection and renaming, trusted names, amount-join, date) |
| Clear-sign layer | KeepKey certified (7.16) | none | ERC-7730 for EIP-712 messages (2.12.x) | Filters derived from ERC-7730 via CAL; "blind-signing friction" added to v0 and unfiltered flows (1.12.0, Sep 2024) |

Notes:
- Ledger filters are keyed to a schema hash: "sha224sum of the value of _types_ … stripped of all spaces and newlines". With full filtering on, "fields will be by default hidden unless they receive a field name substitution". That is a deliberate *hide by default* model. KeepKey and Trezor show every field.
- Trezor's T1 hash-only limit is a documented space trade-off. The Trezor Connect docs note that the One "does not support constructing EIP-712 hashes".

Sources: [ethapp.adoc §SIGN ETH EIP 712, §EIP712 FILTERING](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/ethapp.adoc) · [trezor sign_typed_data.py](https://github.com/trezor/trezor-firmware/blob/main/core/src/apps/ethereum/sign_typed_data.py) · [trezor PR #1568](https://github.com/trezor/trezor-firmware/pull/1568) · [Trezor Connect ethereumSignTypedData (fork mirror)](https://github.com/gabrin/trezor-connect/blob/develop/docs/methods/ethereumSignTypedData.md) [secondary] · [legacy CHANGELOG](https://github.com/trezor/trezor-firmware/blob/main/legacy/firmware/CHANGELOG.md)

---

## 6. Unlimited ERC-20 approvals

| | KeepKey | Trezor | Ledger |
|---|---|---|---|
| `approve(max)` | Allowed; shown as "an UNLIMITED amount" (`ethereum.c`) | Allowed; ERC-7730 `threshold 0x8000…0` → shown as above threshold ("Unlimited") (`clear_signing_definitions.py`) | Allowed; ERC-20 plugin prints "Unlimited " when `ismaxint` |
| Unlimited EIP-2612 / DAI permit | **Refused**: "Unlimited ERC20 approval is disabled" | Signed with full display | Signed (filtered) |
| Permit2 max | Allowed, stated in words | Signed | Signed |

Notes:
- KeepKey is the only one of the three that refuses anything here, and it refuses inconsistently: an unlimited `approve()` gets through, but an unlimited `Permit` does not, although the two carry the same risk. The ERC-7730 spec itself models "Unlimited" as a display threshold, not a refusal.
- Trezor added a dedicated approve/revoke flow in 2.9.0, with an unknown-token warning.

Sources: [ERC-7730 spec (threshold / thresholdLabel "Unlimited")](https://github.com/ethereum/clear-signing-erc7730-registry/blob/master/specs/erc-7730.md) · [trezor clear_signing_definitions.py](https://github.com/trezor/trezor-firmware/blob/main/core/src/apps/ethereum/clear_signing_definitions.py) · [trezor layout.py](https://github.com/trezor/trezor-firmware/blob/main/core/src/apps/ethereum/layout.py) · [app-ethereum erc20_plugin.c](https://github.com/LedgerHQ/app-ethereum/blob/master/src/plugins/erc20/erc20_plugin.c) · KeepKey: `fw716-fix/lib/firmware/ethereum.c`, `eip712_stream.c`

---

## 7. Flash and space limits on the oldest model

| | KeepKey (STM32F205, 1 MB, ~640 KB app) | Trezor One (STM32F205, 1 MB) | Ledger Nano S (ST31 SE, 320 KB) |
|---|---|---|---|
| Strategy | Keep everything; trim passes (7.15/7.16), capability gating | Drop coins, keep EVM minimal, keep new features on core only | End of software support (announced 30 May 2025) |
| Examples | — | Removed Lisk, Firo, Hatch, PIVX, BELL, ZNY, MUE and others; no Cardano, XRP, Monero, Solana on T1; EIP-712 hash-only; no ERC-7730 clear signing; CoSi and `display_random` removed (1.13.0) | CTO: the OS, BTC, ETH and exchange apps nearly fill 320 KB; it cannot get advanced clear signing, Transaction Check or on-device Uniswap swaps |

Notes:
- Trezor's answer to running out of flash on the F205 was to **freeze feature scope on the T1 and move growth to the core models**. The T1 still gets security fixes and the signed-definitions pipeline (1.13.0), and it now rejects the weaker v1 definition format (1.14.2).
- Ledger's plugin spec cites "memory space limitations" even on current devices (Uniswap split paths). App size is a constraint on Ledger too, not only on old models.
- The Orchard write-up from Trezor's Zcash developer puts the problem in flash terms: Sinsemilla needs a 64 KB table, "a significant chunk of storage" against 1 MB (T1) or 2 MB (T).

Sources: [legacy CHANGELOG](https://github.com/trezor/trezor-firmware/blob/main/legacy/firmware/CHANGELOG.md) · [The Block on Nano S EOL, 2025-06-27](https://www.theblock.co/news/business/2025-06-27-memory-constraints-behind-ledgers-decision-to-end-nano-s-software-support-says-cto-360100) [secondary] · [Trezor forum: Model One and Solana](https://forum.trezor.io/t/model-one-does-not-support-solana/18702) [secondary] · [krnak, "What went wrong with Zcash Orchard…"](https://hackmd.io/@krnak/S1gZ_hr6We)

---

## 8. Firmware variants and privacy coins

| | KeepKey | Trezor | Ledger |
|---|---|---|---|
| Bitcoin-only | `KK_BITCOIN_ONLY` CMake option; 7.14.3 btc-only line | Official signed btc-only images for every model (`legacy-bitcoinonly`, `core-<model>-bitcoinonly`); separate vendor header `vendor_trezor_btconly.json`; "Remove altcoin message definitions from bitcoin-only build" (2.4.3) | No btc-only firmware; app model instead (install only the Bitcoin app) |
| Zcash | Transparent + **Orchard in the default image** | Transparent only: "Shielded transactions … are NOT compatible". Orchard work (Zcash Foundation grant, 2021) postponed indefinitely. | Ledger Zcash app: transparent. Zondax "Zcash Shielded" app (Sapling). New native app (Sep 2026) is Ironwood-pool only; Orchard "not shown or spendable" [secondary]. |

Notes:
- Trezor's btc-only build is separately reproducible and signed. Their reproducible-build doc lists both images per model.
- KeepKey is the only one of the three shipping Orchard signing on a hardware wallet. The Trezor write-up names only Keystone as having done it.

Sources: [Trezor reproducible build doc](https://github.com/trezor/trezor-firmware/blob/main/docs/common/reproducible-build.md) · [core CHANGELOG.T2T1](https://github.com/trezor/trezor-firmware/blob/main/core/CHANGELOG.T2T1.md) · [Trezor Zcash page](https://trezor.io/learn/supported-assets/other-cryptocurrencies/zcash-what-it-is-and-how-it-works-with-trezor) · [krnak HackMD](https://hackmd.io/@krnak/S1gZ_hr6We) · [ZF grant](https://grants.zfnd.org/proposals/1792958360-trezor-support-for-zcash-shielded-transactions) · [Zondax Zcash Shielded app](https://zondax.ch/blog/unlocking-privacy-the-new-zcash-shielded-app-for-ledger) · [zeczcash.com Ledger guide, 2026-09-26](https://zeczcash.com/blog/zcash-ledger-wallet) [secondary] · KeepKey: `fw716-fix/CMakeLists.txt`

---

## 9. Passkeys / FIDO2

| | KeepKey | Trezor | Ledger |
|---|---|---|---|
| U2F | Yes (`u2f.c`, USB U2F HID interface) | Yes, all models | Yes (Security Key app; native on Stax/Flex [secondary]) |
| CTAP2 | `ctap2.c` / `ctap2_cbor.c` in firmware. Internal notes flag that CTAP2 may not be reachable from hosts and that a competing software-authenticator design exists [unverified] | **T / Safe only**, since 2.1.6 (Oct 2019); Apple fix 2.6.0; credential pagination 2.11.1. T1 is U2F only. | CTAP2 in `app-security-key` (2.0 implemented; 2.1–2.3 listed) |
| Resident credentials | [unverified] | Supported, managed via `trezorctl` | **Disabled**: stored in app flash "that gets wiped upon app deletion (on uninstall, app update, or OS update)" |

Sources: [core CHANGELOG.T2T1 (FIDO2 entries)](https://github.com/trezor/trezor-firmware/blob/main/core/CHANGELOG.T2T1.md) · [legacy u2f.c](https://github.com/trezor/trezor-firmware/blob/main/legacy/firmware/u2f.c) · [LedgerHQ/app-security-key README](https://github.com/LedgerHQ/app-security-key) · KeepKey: `fw716-fix/lib/firmware/ctap2.c`, `lib/board/usb.c`

---

## 10. PIN, auto-lock, wipe code, passphrase

| | KeepKey | Trezor | Ledger |
|---|---|---|---|
| PIN failures | Exponential wait 2^n s after 3 failures (`pin_sm.c`); **no auto-wipe** | Doubling delay; wipe after 16 (T1, T, Safe 3/5) or 10 (Safe 7) | **Wipe after 3** wrong PINs |
| Auto-lock default | 10 min (`STORAGE_DEFAULT_SCREENSAVER_TIMEOUT`), min 30 s | 10 min (`autoLockDelayMsDefault`, T1); min 1 min since 2020 | 2 min default on Nano; options 1/2/5/10 min [secondary] |
| What renews idle | Button press, correct PIN, validated workflow progress. Host polls and partial frames do **not** (`home_sm.c`) | 2.6.0: "Auto-lock timer is no longer restarted by USB messages, only touch screen activity" | [unverified] |
| Wipe code | Yes (`change_wipe_code`, 7.15+) | Yes (T1 1.9.0, Apr 2020; core 2.2.0, Jan 2020) | No wipe code; 3-try wipe instead [unverified as a deliberate equivalent] |
| Passphrase | Host entry | On device or host; up to 10 cached sessions | "Attach to a PIN" (second PIN) or temporary [unverified, not fetched] |

Notes:
- KeepKey's idle-timer rule matches Trezor's 2.6.0 fix (#2651) closely. Both stop host traffic from keeping a device unlocked.
- KeepKey is the only one of the three with no PIN-attempt wipe. That is a deliberate trade (no accidental-loss wipe), but it is unusual.

Sources: [Trezor PIN protection guide](https://trezor.io/guides/trezor-devices/trezor-fundamentals/pin-protection-on-trezor-devices) · [trezor legacy config.c](https://github.com/trezor/trezor-firmware/blob/main/legacy/firmware/config.c) · [core CHANGELOG.T2T1](https://github.com/trezor/trezor-firmware/blob/main/core/CHANGELOG.T2T1.md) · [Ledger: configure PIN lock](https://support.ledger.com/article/360019255553-zd) [secondary snippet] · [Ledger: lost or stolen](https://support.ledger.com/article/9729302536989-zd) · KeepKey: `fw716-fix/include/keepkey/firmware/storage.h`, `lib/firmware/home_sm.c`, `lib/firmware/pin_sm.c`

---

## 11. Firmware signing and release

| | KeepKey | Trezor One | Trezor T / Safe | Ledger |
|---|---|---|---|---|
| Scheme | 3 of 5 ECDSA secp256k1 (`docs/Release.md`: "Sign it on the airgapped machine with 3/5 signers") | `PUBKEYS_V2 = 5`, 3 distinct sigs, secp256k1; plus a v3 "verifymessage" set of 3 keys needing 2 (`legacy/fw_signatures.c`) | Boardloader (write-protected) → bootloader → firmware. Vendor header: `sig_m: 2` of 3 Ed25519 vendor keys (Safe 5 `vendor_trezor.json`). Headers SatoshiLabs-signed via CoSi sigmask. | BOLOS signed by Ledger HSM and pushed over an authenticated secure channel; apps signed by Ledger |
| Unsigned / unofficial | "Unrecognized firmware" + firmware-hash confirm; storage wiped unless the old firmware was signed | "WARNING! Unofficial firmware detected" + fingerprint; storage wiped if the old or new firmware is unsigned | `vendor_unsafe`: red background, required click, vendor string shown, `allow_run_with_secret: false` | Custom apps allowed on Nano S Plus/Stax/Flex with warnings; Nano X Ledger-signed only [secondary] |
| Reproducible | Multi-machine hash compare (manual) | Docker/Nix `build-docker.sh`; zero-signature comparison | Same | OS closed source; not reproducible |

Notes:
- KeepKey's 3-of-5 is the same shape as the T1's original scheme (both come from the same codebase). Trezor added a second "v3" key set (2 of 3) for the new header and checks both with XOR to avoid timing side channels.
- Trezor's vendor-header `vtrust` bitmap is a mechanism worth copying: unofficial builds can run, but visibly, and **without access to secrets**.
- Trezor's version header carries `fix_v*` (the last critical-bugfix version), which drives storage-keep decisions. This corresponds to KeepKey's "downgrade wipes" policy.

Sources: [Trezor One firmware format](https://github.com/trezor/trezor-firmware/blob/main/docs/legacy/firmware-format.md) · [legacy/fw_signatures.c](https://github.com/trezor/trezor-firmware/blob/main/legacy/fw_signatures.c) · [legacy/bootloader/usb.c](https://github.com/trezor/trezor-firmware/blob/main/legacy/bootloader/usb.c), [bootloader.c](https://github.com/trezor/trezor-firmware/blob/main/legacy/bootloader/bootloader.c) · [core boot.md](https://github.com/trezor/trezor-firmware/blob/main/docs/core/misc/boot.md) · [T3T1 vendor_trezor.json](https://github.com/trezor/trezor-firmware/blob/main/core/embed/models/T3T1/vendorheader/vendor_trezor.json) · [vendor_unsafe.json](https://github.com/trezor/trezor-firmware/blob/main/core/embed/models/T3T1/vendorheader/vendor_unsafe.json) · [reproducible-build.md](https://github.com/trezor/trezor-firmware/blob/main/docs/common/reproducible-build.md) · [Ledger Donjon genuineness threat model](https://donjon.ledger.com/threat-model/device-genuineness/) · KeepKey: `fw716-fix/docs/Release.md`, `tools/bootloader/main.c`, `tools/bootloader/usb_flash.c`

---

## 12. Device authenticity, RNG and entropy

| | KeepKey | Trezor | Ledger |
|---|---|---|---|
| Authenticity | No secure element; firmware/bootloader hash checks | Safe 3/5/7: OPTIGA Trust M (+ TROPIC01 on Safe 7) signs a Suite challenge with a factory certificate; ML-DSA-44 MCU signature added May 2026 [secondary for ML-DSA] | SE attestation: factory keypair, Issuer cert; HSM challenge on Genuine Check and on updates |
| User-verifiable entropy | **Dice** (7.14.3 / 7.15): 50/75/99 rolls, SHA-256 digest shown, mixed in before the host `EntropyRequest`; RNG health test | **Entropy check** (core 2.8.7 Jan 2025, T1 1.13.1 May 2025): device commits, then Suite checks the reveal against the commitment, rebuilds the wallet and compares XPUBs. No dice. `display_random` removed (T1 1.13.0). | None user-visible; SE TRNG |

Notes:
- KeepKey's own `docs/DiceEntropy.md` says the digest proves the rolls were *recorded*, not that they reached the seed. Trezor's entropy check proves the opposite property, that the host's entropy was used, and it does so against counterfeit firmware. The two are complementary, and KeepKey could adopt the commit/reveal check.

Sources: [Trezor entropy check](https://trezor.io/learn/security-privacy/how-trezor-keeps-you-safe/entropy-check-how-trezor-suite-verifies-wallet-generation) · [Trezor Safe authentication check](https://trezor.io/learn/security-privacy/how-trezor-keeps-you-safe/trezor-safe-device-authentication-check) · [Ledger Donjon genuineness](https://donjon.ledger.com/threat-model/device-genuineness/) · [legacy CHANGELOG](https://github.com/trezor/trezor-firmware/blob/main/legacy/firmware/CHANGELOG.md) · KeepKey: `fw716-fix/docs/DiceEntropy.md`

---

## Lessons for KeepKey

1. **Signed-definition container prior art (Trezor `trzd`).** One format serves networks, tokens, Solana tokens and ERC-7730 display formats: `magic‖fmt_ver‖type‖data_version(u32)‖len‖protobuf`, then a Merkle proof and one CoSi signature over the **root**. Benefits: a single signature covers the whole catalogue, any item can be served statically (CDN or tarball, no per-tx query, better privacy), and a per-type tag blocks cross-parsing. KeepKey's per-item delegate signatures cost more per item but allow per-chain scoping and expiry, which Trezor lacks. A hybrid would work: a delegate signs a Merkle root per chain and epoch.
2. **Freshness floors.** Trezor puts a `MIN_DATA_VERSION` timestamp in each firmware ("about one month before release"). That gives rollback protection without device clocks. KeepKey's cert expiry depends on the host supplying time or on a firmware-raised minimum. Adopt the same "data_version ≥ firmware floor" rule as the primary revocation tool, and keep cert expiry as a backstop.
3. **Watch Trezor's threshold drift.** Trezor went from 2 signatures to 1 of 3 for definitions (format v2) and forced the T1 onto v2 in 1.14.2, trading assurance for operations. If KeepKey's root ceremony is single-key, document it as such and compare it honestly.
4. **Ledger FIELDS_HASH equals KeepKey v2.** Signing a header that commits to an ordered hash of field descriptors is a proven way to make reusable schemas cheap on small devices. KeepKey's v2/v5 schemas are the same idea, which supports that design over v1 per-tx-hash descriptions.
5. **Ledger trusted names expire by app version** (`NOT_VALID_AFTER` = major.minor.patch) and can carry a device `CHALLENGE` nonce. That gives revocation tied to releases plus anti-replay, with no clock needed.
6. **Fuzz the gate edges.** Ledger shipped three blind-signing bypasses in 2026 (`0x00` calldata, EIP-712 filter activation, swap flow). Add those exact cases to KeepKey's AdvancedMode and certified-path tests: 1-byte calldata, a filter or descriptor present but empty, swap or exchange entry points.
7. **Make the unlimited policy consistent.** Both peers display "Unlimited" via a threshold and allow signing. KeepKey refuses unlimited permits but allows unlimited `approve()`. Pick one rule, and the ERC-7730 `threshold`/"Unlimited" display is the industry norm.
8. **Scope discipline on the F205.** Trezor froze the T1 (no clear signing, hash-only EIP-712) and Ledger killed the Nano S over 320 KB. KeepKey is doing more on the same silicon. That is a differentiator, and it also argues for measurable ROM budgets and per-feature capability gating, both of which KeepKey already has.
9. **Unofficial-firmware UX.** Trezor's vendor-trust bitmap (red background, click to continue, **no secret access**) is stronger than a one-time "take the risk?" prompt. Consider denying seed access to unsigned images rather than only wiping on transition.
10. **Entropy: add commit/reveal.** Dice prove the device recorded the input. Trezor's entropy check proves the host entropy reached the seed. Offering both would put KeepKey ahead of both peers on seed-generation verifiability.
11. **Idle timer.** KeepKey's rule (host traffic never renews) matches Trezor 2.6.0. Keep it, and consider stating it in user docs as Trezor does.
12. **PIN wipe.** KeepKey is the only one of the three with no N-failure wipe. Exponential delay is defensible, but write the rationale into PRODUCT_TRUTH and compare it explicitly with Trezor's 16 and Ledger's 3.

### Open items not verified
- Exactly how Trezor 2.11.1 decodes Universal Router `execute` commands (display format vs. built-in). The changelog's linked PR number (#69) looks wrong.
- Ledger auto-lock default and passphrase modes (support pages did not render; search snippets only).
- Whether KeepKey's CTAP2 path is reachable from a browser in shipped builds.
- Ledger's behaviour for an ERC-20 approve when the CAL token record is missing.
