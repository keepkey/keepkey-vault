# Installed 1.6.7 network and asset report — candidate reconciliation

The user supplied a Windows 11 audit of installed Vault 1.6.7, build
`118fba3221cd8d7d`, dated November 9. Its evidence is bundle inspection and remote
requests, without window interaction or backend inspection. This reconciliation
checks the development candidate; it does not claim Windows acceptance or a real
HyperEVM transaction.

| Report item | Candidate finding | Disposition |
| --- | --- | --- |
| Hyperliquid chain ID 2868 | Confirmed in the pre-fix candidate and upstream SDK metadata | Fixed: mainnet 999 throughout built-in identity and discovery; the unrelated 2868 network is not aliased |
| Base uses Ethereum logo | Already corrected by integrated PR #637 | Bundled Base-specific icon and offline regression included |
| Missing token CDN logos | A remote catalog/content availability issue; the reported 27/300 sample is not a full census | Candidate already prefers bundled icons, then available metadata/CDN sources, then a controlled letter fallback; server coverage is not claimed fixed |
| Polygon native symbol MATIC | Confirmed stale display metadata | Fixed native Polygon PoS display to POL in chain and asset-picker metadata; chain 137 and legacy SDK enum identifiers preserved |
| Non-EVM receive QR prefixes | Confirmed bare addresses in the generic Receive view | Added established BTC/LTC/DOGE/DASH/DGB/ZEC/BCH schemes; displayed/copied addresses and existing EVM checks preserved |
| XRP receive destination tag | Report conflates receiving into a personal address with receiving into an exchange's shared address | Do not invent a tag for a KeepKey-owned address; exchange-required tags belong on the outgoing payment to that exchange |
| Monad/Hyperliquid explorers | Missing built-in templates confirmed | Added verified mainnet explorer templates in chain and asset metadata |
| Swap-history explorer identity | Additional confirmed defect: links selected by ticker sent Base ETH to Ethereum | Fixed: saved source-chain identity selects the explorer, including token swaps; missing identities omit the link |
| Shielded Zcash explorer | A shielded address cannot be used to enumerate its private balance/history | Do not treat absence of a public address lookup as the same defect as missing EVM explorer metadata |
| THORChain/Tron quality and mixed shapes | Cosmetic asset observations retained | Separate asset-quality follow-up; no speculative logo replacement during release qualification |
| Hardcoded English | Path-editor and Receive video examples already use the translation helper | Remaining TON UQ/EQ labels and Activity status/confirmation/payout/copy labels are recorded for localization follow-up |
| Hive explorer 502 | A transient result in the supplied audit | No permanent host replacement based on that one response; availability is not claimed fixed |

## Authoritative identity and payment references

- [Hyperliquid HyperEVM documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm)
  specifies mainnet chain ID 999 and the official RPC. This corrects built-in
  identity; it does not change the user's selected provider policy.
- [Polygon's migration announcement](https://polygon.technology/blog/matic-to-pol-migration-is-now-live-everything-you-need-to-know)
  identifies POL as the Polygon PoS gas token. `MATIC` SDK enum keys remain
  compatibility identifiers, not instructions to rename unrelated Ethereum tokens.
- [XRP Ledger source and destination tags](https://xrpl.org/docs/concepts/transactions/source-and-destination-tags)
  explains hosted/shared-address customer attribution. A personal receiving
  address does not acquire an exchange customer tag merely because some exchanges
  require one for their own deposits.
- [Bitcoin payment URIs](https://bips.dev/21/) and
  [Zcash ZIP 321](https://zips.z.cash/zip-0321) establish their respective payment
  schemes. BIP 21 is now superseded by BIP 321; a plain `bitcoin:<address>` remains
  the compatible address-only request used here.

## Limits

The 9% logo rate belongs to the supplied 300-item sample and has not been
generalized to all assets or remeasured here. HTTP 403 alone does not distinguish
a missing object from an access policy; the supplied AccessDenied responses are
recorded as unavailable objects, without asserting the server's underlying cause.
No user addresses were sent to explorers or nodes for this review. The running
testing preview remains unchanged while these source fixes are qualified.

## Validation

- Eight HyperEVM regression cases exercise the actual transaction builder,
  production signing/custom-chain callbacks, Pioneer network arguments, Receive
  URIs, incoming attribution, picker/catalog identity and custom-chain isolation.
  The previous candidate reproduces 2868 signing arguments and QR metadata.
- The actual Receive component is rendered with captured QR and clipboard
  adapters. Its previous source fails seven newly added scheme checks; current
  tests preserve raw addresses, BCH prefix-once behavior, EVM token semantics and
  mismatch rejection. XRP/Cosmos/THOR/Hive remain raw rather than inventing schemes.
- The actual SwapRow is clicked through its real open-URL callback. The previous
  source opens Etherscan for Base ETH; current tests cover seven network/asset
  combinations and five invalid identities, including token swaps and TRON hash
  normalization.
- Focused metadata/receive/explorer/discovery/route/catalog/icon checks pass
  **213 tests / 1,045 assertions**. Final core regression passes **1,601 tests
  and 93 script assertions**, with zero failures or skips.
- Backend and frontend builds pass. Type checking retains the inherited 799
  diagnostics; new source diagnostics were corrected, without changing the
  TypeScript target or suppressing checks.
- New tests are registered as isolated CI invocations. The live preview was not
  restarted; platform CI and Windows interaction remain distinct checks.

Primary non-Bitcoin formatter references:
[Litecoin Core](https://github.com/litecoin-project/litecoin/blob/master/src/qt/guiutil.cpp),
[Dogecoin Core](https://github.com/dogecoin/dogecoin/blob/master/src/qt/guiutil.cpp),
[Dash Core](https://github.com/dashpay/dash/blob/master/src/qt/guiutil.cpp),
[DigiByte Core](https://github.com/DigiByte-Core/digibyte/blob/develop/src/qt/guiutil.cpp),
[CashAddr](https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md).
Explorer metadata follows
[Monad's explorer list](https://docs.monad.xyz/tooling-and-infra/block-explorers) and
[Hyperliquid's setup documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/how-to-use-the-hyperevm).
