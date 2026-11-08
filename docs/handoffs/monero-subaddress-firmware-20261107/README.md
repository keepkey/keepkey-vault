# Monero firmware support for standard addresses and subaddresses

Extend the portable KeepKey Monero signer so Vault can send to both standard addresses and subaddresses. The immediate acceptance case is a small, explicitly reviewed transfer from the restored hardware wallet to the user's Feather subaddress. Keep normal Receive and Send actions in Vault; address type and signing protocol selection should be automatic.

## Current device and Vault state

The physical KeepKey runs the unsigned 7.17.0 candidate at `firmware/unsigned/monero-device-candidate-20261107/firmware.keepkey.bin`, SHA256 `9bc7798fb71a744c23a81cb7987645b7b5418d16fd035acc00770d57d4ae4928`. Its source and qualification guide are in `modules/keepkey-firmware/tools/monero-feasibility/DEVICE_CANDIDATE.md` in `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11-agent-1`.

The candidate supports signing with **one confidential input, two standard-address outputs, ring size 16, transaction version 2, unlock time zero and HF16 CLSAG/Bulletproof+**. Source subaddresses are supported. Destination/change subaddresses, source additional transaction public keys and multiple inputs are rejected. Hardware uses **65002/65003**; the older signing emulator uses **65000/65001**. Removing an emulator gate alone does not implement hardware signing.

The restored physical wallet is PIN protected. Its Monero address is `44J3pVF3V2yS3QSXNwug3f8jWqRvaDbfGiowDV6YP8WBQD3wSq2gzGh8WyjqELm1Ukc2FuspCEkm1ZX5DHzpGC9pJJV9wHV`. Vault completed physical view-key and key-image approval and displayed **Synced, 0.08465305 XMR, unlocked**, using `https://xmr.triplebit.org` and scan start **3799129**. No payment has been prepared, signed or broadcast during this balance check. The balance is a point-in-time observation, not a test fixture.

Vault source is `/Users/highlander/keepkey-toolchain/vault-xmr`, branch `feat/xmr-own-node`; the working implementation is also on `feat/monero-local-node` at `/private/tmp/keepkey-c5-resume/fix`. Balance verification was fixed in `13419cd75`; encrypted monitoring persistence is in `f9833f887`. The Vault adapter now implements 65002/65003 for this exact candidate and verifies output bindings plus Core CLSAG/Bulletproof+ results. A public fixture passed against the candidate emulator; physical signing and the future subaddress firmware still require qualification. Preserve concurrent Zcash/settings/password work. Never stage submodule symlinks from the temporary worktree.

## Recipient acceptance case

Feather destination supplied by the user:

```text
86jm8LffqcZ2hZHb6KqibUZRmfG6puiFhTD8YahevKN1F68yVT5nVHCFtweBUn17fVafbimZgWckYccjuXuxisLsSa5HF5X
```

This is a mainnet subaddress. The user requested a small transfer. An earlier proposed test amount was **0.001 XMR**; the exact amount, fee and total still require a concrete review and user approval before signing or broadcasting. Do not substitute another recipient or sweep the balance. Use disposable fixtures and an isolated private chain for automated signing and broadcast tests.

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

## Vault validation completed

The affected Monero suites passed **193 tests across 15 files**, and six i18n safety tests passed. The candidate emulator completed the new Vault adapter request with nine review prompts; independent output, CLSAG and Bulletproof+ verification passed, and a modified signature was rejected. This was a disposable public fixture, with no physical device access or broadcast. The current TypeScript check reports the same 803 existing diagnostics as the preceding integration state, with no new normalized diagnostics. See [Vault validation results](vault-results.json).

## Suggested task for the firmware session

Implement standard-address and subaddress destinations in the portable C Monero signer, including canonical transaction-key/additional-key handling, host BP+ mask preparation and independently verified change reuse. Start from the candidate and source paths above, preserve its current limits and authentication behavior, and coordinate the 65002/65003 protocol with Vault. Return a new unsigned candidate folder, updated host libraries and protocol contract, hashes and passing regression/resource evidence. Do not flash hardware or move real funds. The Feather subaddress above is the later user-approved end-to-end acceptance destination.
