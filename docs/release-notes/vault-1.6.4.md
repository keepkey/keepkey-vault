# KeepKey Vault v1.6.4 — prerelease

## Bitcoin transaction exchange

- Import a PSBT by dropping a file, pasting it, or scanning a supported QR. Review recipients, change and fees before confirming on KeepKey; export the signed PSBT for your coordinator.
- Create unsigned PSBTs from a saved watch-only wallet without attaching KeepKey to the online computer. Import/export public wallet metadata with its fingerprint, origin, script type and receive/change branches.
- Exchange PSBTs with Sparrow and Electrum. Native SegWit, wrapped SegWit, legacy and BIP86 Taproot key-path single-signature accounts are supported. Taproot script-path spending is outside this workflow.
- Import a completed PSBT or raw transaction for explicit broadcast with KeepKey disconnected. Review names the backend, preserves the selected Bitcoin node, and verifies the returned transaction ID.
- QR transport supports animated UR, BBQr and Electrum Base43 transaction QR. Public wallet/policy metadata can also be exchanged through supported QR formats.

For offline signing, disconnect the computer from the network; KeepKey communicates with it over USB. Desktop’s offline setting suppresses app network requests. Files, removable media and transaction parsers remain attack surfaces, and an offline computer cannot know whether an input was subsequently spent.

## Experimental multisig — off by default

Enable **Settings → Feature Flags → Bitcoin multisig co-signing** to verify a public wallet policy and add KeepKey’s signature to a Sparrow/Electrum PSBT. The setting is persistent and takes effect without rebuilding or restarting. Existing saved policies do not enable it automatically.

Classic native/wrapped SegWit and legacy multisig are supported; Taproot multisig/MuSig2 is outside scope. KeepKey is the only hardware signer integrated in Vault. Other signers stay in the coordinator. Vault preserves earlier signatures and returns partial PSBTs below quorum. Final transaction broadcast remains available with the feature flag off.

## Review and history

- ClearSign approval cards show the decoded contract description presented by supported firmware.
- Transaction history includes ClearSign review information and clearer transaction details.
- Address Book certification reviews every selected contact and supports excluding individual contacts before device certification.

## Known limits

- Bitcoin Core watch-only creation currently supports send-max; full change-index discovery is available through Blockbook. Core history discovery remains unsupported.
- Multisig verification requires complete public origins and full previous transactions for offline fee verification; ambiguous/incomplete files are refused.
- Physical camera QR transfer, physically disconnected two-computer operation, and every coordinator/plugin/passphrase/account combination have not all been demonstrated. Do not treat parser or library checks as that evidence.
- The current synthetic multisig signing/broadcast-path checks do not demonstrate a successful funded multisig broadcast.
