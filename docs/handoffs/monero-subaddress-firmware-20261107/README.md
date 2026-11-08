# Monero firmware support for standard addresses and subaddresses

The subaddress firmware work is complete in the November 8 candidate. The user completed a hardware-to-Feather transfer; an independent lookup found it mined in block **3,801,979**, and the user confirmed Feather detected the payment. The original firmware requirements below remain a reference for qualification and future changes.

## Completion on November 8 2026

The physical device runs candidate SHA256 `123af6de3b5ddbc1eeb94568825d1bb8107079bc9100ac67f9f6162ca34e2f83`, from `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11-agent-1/firmware/unsigned/monero-device-subaddress-candidate-20261108`. It supports standard and subaddress destinations, construction versions 1 and 2, and up to 16 source additional transaction keys within the existing one-input/two-output/ring-16 bounds. The funded wallet was restored again after flashing, its `44J3pVF3…` address was verified, and the user set the PIN; Vault Security showed PIN protection enabled.

Successful mainnet transaction:

```text
2edd5c273bf44b629be55760ae7d5d8467dd1fc0e3857b3dc2d1ccb75da6fb6a
```

The user initiated and approved this transfer. The configured Seth node independently reported the transaction mined at block 3,801,979; the user supplied recipient-side confirmation from Feather. See [mainnet test result](mainnet-subaddress-result-20261108.json).

## Live session and next preview

The live preview includes USB transport recovery and the new firmware adapter. Vault and Feather remain open after the successful transfer.

Automatic remote failover and connection diagnostics are built in a **separate, unlaunched** next preview at `/private/tmp/keepkey-c5-resume/fix/projects/keepkey-vault/_build/dev-macos-arm64/keepkey-vault-dev.app`. It tries another listed HTTPS preset when a node fails, waits 30 seconds after exhausting candidates, and shows the active node, recent failures, reported height, response latency, last successful response and retry time. Local and custom nodes retain their configured connection. Device cancellations remain cancelled; transaction review and pending broadcasts pause automatic node changes. A new monitoring session rechecks known outputs using the saved signed proofs where possible.

All **254 tests across 20 files** passed, including five native candidate cases. Backend, frontend, native packaging and i18n integrity passed. TypeScript reports the same 803 existing diagnostics, with no new normalized messages. The separate preview has not been launched against the live wallet. See [failover build results](failover-results-20261108.json).

The SSD node remains stopped because its capacity check requires roughly 15 GiB more free space under the current 105 GiB chain estimate and 25 GiB reserve. Its last observed free space was 98.5 GiB; the stored chain remains intact.

## Original November 7 candidate

The original physical-device build was the unsigned 7.17.0 candidate at `firmware/unsigned/monero-device-candidate-20261107/firmware.keepkey.bin`, SHA256 `9bc7798fb71a744c23a81cb7987645b7b5418d16fd035acc00770d57d4ae4928`. Its source and qualification guide are in `modules/keepkey-firmware/tools/monero-feasibility/DEVICE_CANDIDATE.md` in `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11-agent-1`.

The original candidate supported signing with **one confidential input, two standard-address outputs, ring size 16, transaction version 2, unlock time zero and HF16 CLSAG/Bulletproof+**. Source subaddresses are supported. Destination/change subaddresses, source additional transaction public keys and multiple inputs are rejected. Hardware uses **65002/65003**; the older signing emulator uses **65000/65001**. Removing an emulator gate alone does not implement hardware signing.

The restored physical wallet is PIN protected. Its Monero address is `44J3pVF3V2yS3QSXNwug3f8jWqRvaDbfGiowDV6YP8WBQD3wSq2gzGh8WyjqELm1Ukc2FuspCEkm1ZX5DHzpGC9pJJV9wHV`. Vault completed physical view-key and key-image approval and displayed **Synced, 0.08465305 XMR, unlocked**, using `https://xmr.triplebit.org` and scan start **3799129**. No payment has been prepared, signed or broadcast during this balance check. The balance is a point-in-time observation, not a test fixture.

Vault source is `/Users/highlander/keepkey-toolchain/vault-xmr`, branch `feat/xmr-own-node`; the working implementation is also on `feat/monero-local-node` at `/private/tmp/keepkey-c5-resume/fix`. Balance verification was fixed in `13419cd75`; encrypted monitoring persistence is in `f9833f887`. The Vault adapter now implements 65002/65003 for this exact candidate and verifies output bindings plus Core CLSAG/Bulletproof+ results. A public fixture passed against the candidate emulator; physical signing and the future subaddress firmware still require qualification. Preserve concurrent Zcash/settings/password work. Never stage submodule symlinks from the temporary worktree.

## Recipient acceptance case

Feather destination supplied by the user:

```text
86jm8LffqcZ2hZHb6KqibUZRmfG6puiFhTD8YahevKN1F68yVT5nVHCFtweBUn17fVafbimZgWckYccjuXuxisLsSa5HF5X
```

This is the mainnet subaddress supplied for the successful Feather test. The user selected and approved the live transfer in Vault. Future transfers require their own concrete amount, fee and total review. Automated signing and broadcast qualification uses disposable fixtures and an isolated private chain.

## Firmware changes

1. Decode and validate standard and subaddress prefixes and checksums on each supported network. Preserve the full approved destination address, amount, fee and change ownership in the device review and approval digest. Keep integrated-address rejection explicit unless separately implemented.
2. Construct canonical Monero transaction public keys, any required additional transaction public keys, stealth output keys, view tags, encrypted amounts and commitments for both address types. Match pinned Monero Core's address classification and change handling. In particular, a subaddress destination changes transaction-key derivation; accepting its prefix while retaining standard-address construction would send incorrectly.
3. Define the exact protocol fields for transaction scalars and any per-output additional keys. Bind every field into the grant digest, validate scalar/point encodings and revoke the grant on cancellation, Initialize, session clearing, PIN/passphrase failure or unexpected nested requests. Keep wallet spend keys and one-time spend scalars on the device.
4. Extend host proof preparation consistently. The existing host BP+ API receives two amounts and two commitment masks. Derive those masks using the same standard/subaddress and change rules as the device. A single subaddress recipient with ordinary change can require different derivation from simply multiplying each destination view public key by the main transaction scalar. Specify that case explicitly against Core before implementation.
5. Either support the additional transaction keys needed to spend outputs created by the new path, or document and enforce a bounded construction that avoids an unsupported future spend. Prove both recipient recovery and change reuse; a successful initial broadcast alone is insufficient.
6. Retain the existing one-input/two-output/ring-16 limits unless a separately measured expansion is necessary. Recheck upload space, SRAM, stack and heap on the final ARM image. Preserve all working address, view-key and encrypted key-image commands.

Bulletproof+ generation and independent cryptographic verification remain host-side for this research candidate. Do not describe on-device proof verification as implemented. Keep the existing production release restrictions.

## Vault integration contract

- Detect the exact qualified firmware hash or an authenticated capability with a defined version. Never enable hardware sending merely because the firmware version is 7.17.0.
- Select 65002/65003 for the portable hardware candidate and 65000/65001 only for the existing Core-backed signing emulator. Do not switch the user's active wallet or require an emulator to send from supported physical firmware.
- Add the new proof/verification tools and hashes to the development build. Signed releases must continue to reject research-only packaging. The current host libraries are `libmonero_device_proof.dylib` and `libmonero_core_verify.dylib`; regenerate and pin them when their API changes.
- Validate the supported transaction shape before device review. Use precise messages for unsupported limits, rather than an emulator-only message on supported hardware.
- Independently verify CLSAG, Bulletproof+, transaction hash, inputs/key images, rings, fee, **exact destination output keys and amounts**, view tags, extra/public keys and change against the approved plan. Core's generic `monero_core_verify` checks signatures/proofs and rings but does not alone prove that outputs pay the approved addresses; preserve a separate output-binding check.
- Keep prepare, user review, device signing and relay separate. Preserve persisted unknown-broadcast recovery and the discarded-transaction input reuse guard. A verification failure must prevent relay.
- Keep approved view keys encrypted in Vault's local SQLite database using an OS-keystore key, scoped to device, seed/passphrase wallet, network and derivation path. Cache receive addresses and signed key-image proofs. Reuse proofs only for the exact known output set and recheck spent state with the configured node. New outputs may need fresh device approval. No seed, PIN or view key belongs in frontend RPC, logs or this handoff.

## Required acceptance evidence

| Case | Required result |
| --- | --- |
| Standard recipient and main-address change | Existing vectors and real private-chain spend still pass |
| Subaddress recipient and main-address change | Independent Core proof/signature verification; recipient scans exact amount; change scans exact amount |
| Source subaddress | Owned input accepted and correct key image produced |
| Required additional keys | Canonical framing and point validation; recipient and later spender both recover correctly |
| Change reuse | Second private-chain spend consumes the first transaction's change |
| Address and network errors | Bad checksum, wrong prefix/network and unsupported integrated address rejected before approval |
| Tampering | Recipient, change, fee, amounts, key metadata, masks, proof, ring and protocol fields cannot change after approval |
| Authentication and cancellation | PIN/passphrase, cancel on every review page, unplug/reconnect and session reset revoke stale grants |
| Resource limits | Final linked ARM archives pass execution/sanitizers and fit measured flash/SRAM/stack bounds |
| Vault hardware path | Exact candidate recognized; correct protocol used; physical buttons review exact address, amount, fee and change; no emulator-only gate |
| Restart and node failure | Saved monitoring access resumes; new outputs trigger needed verification; interrupted relay cannot pay twice |

Repeat the existing address, watch-key, key-image, portable signing, ARM execution and isolated-chain suites. Package a new unsigned candidate with firmware/host artifact hashes, source revision, qualification receipts, ABI/protocol description and exact resource measurements. Preserve the current candidate and receipts for comparison. Flash only after the user explicitly chooses the new artifact; never wipe or restore the user's funded device as part of automated qualification.

## Original November 7 validation

The affected Monero suites passed **193 tests across 15 files**, and six i18n safety tests passed. The candidate emulator completed the new Vault adapter request with nine review prompts; independent output, CLSAG and Bulletproof+ verification passed, and a modified signature was rejected. This was a disposable public fixture, with no physical device access or broadcast. The current TypeScript check reports the same 803 existing diagnostics as the preceding integration state, with no new normalized diagnostics. See [Vault validation results](vault-results.json).

## Original firmware task

Implement standard-address and subaddress destinations in the portable C Monero signer, including canonical transaction-key/additional-key handling, host BP+ mask preparation and independently verified change reuse. Start from the candidate and source paths above, preserve its current limits and authentication behavior, and coordinate the 65002/65003 protocol with Vault. Return a new unsigned candidate folder, updated host libraries and protocol contract, hashes and passing regression/resource evidence. Do not flash hardware or move real funds. The Feather subaddress above is the later user-approved end-to-end acceptance destination.
