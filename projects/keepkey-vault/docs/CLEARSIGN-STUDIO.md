# ClearSign Studio

ClearSign Studio is an Advanced-mode developer tool in Vault. It is the local
authoring, attestation, signer-loading, and evidence environment for proving
the self-service workflow before KeepKey publishes a firmware-pinned
production ClearSign identity.

Open it from **Device Settings → Signing Policy → ClearSign Studio** after
enabling Advanced Mode.

## Release boundary

This release intentionally has no baked KeepKey ClearSign public key.

- The regular firmware contains the constrained attestor; there is no separate
  attestor build variant.
- Reading the attestor key, attesting a schema, loading a signer, and consuming
  runtime-signed metadata all require Advanced Mode.
- Loaded identities are RAM-only. Reboot, `Initialize`/`ClearSession`, PIN
  session teardown, and disabling Advanced Mode clear them.
- Runtime metadata is annotation-only. EVM still shows its normal raw calldata
  review; Solana still shows its normal unverified-transaction warning.
- The attestor is not a raw signing oracle. The current implementation accepts
  only descriptors that pass the firmware's `KKSOLSC1` parser and displays
  every program, discriminator, argument label, and account label on-device.

The intended later release reads the public key from a signed device, reviews
the evidence, and pins that key in signed firmware. That promotion is a
separate release decision; the Studio does not perform it.

## Studio workflow

1. **Author & attest** creates a `KKSOLSC1` descriptor from a Solana program
   ID, discriminator, human labels, fixed-width arguments, and selected
   accounts. Vault serializes it with the firmware's exact limits and displays
   the canonical hex before anything is sent to the device.
2. **Inspect** parses pasted/raw hex back into the authoring form. This makes
   byte-level negative tests possible without hiding what the bytes claim.
3. **Author / sign payload** sends the canonical descriptor. The device parses
   it again, displays every claimed label, and returns compact ECDSA over
   `SHA256(payload)`. **Copy signed bundle** exports payload and signature in
   the base64 shape accepted by `SolanaSignTx.schema`.
4. **Load identity** can either read the connected device's dedicated attestor
   public key or accept a pasted 33-byte compressed secp256k1 key. The verifying
   device must approve its alias and fingerprint in a selected RAM slot.
5. **Evidence** lists durable local results for the current device: descriptor
   attestations, signer loads, and EVM/Solana transactions carrying ClearSign
   metadata. Signed and blocked views are filterable, and every record exposes
   the exact descriptor plus whether it reached the device transport.

The bundled Relay fixture is the firmware/SDK parity vector for the real Relay
Bridge `depositNative` instruction. Building the pre-filled form must reproduce
that vector byte-for-byte. It is useful for parser and screen-flow testing; it
is not a general contract registry.

## Evidence storage and privacy

Evidence is stored in the local Vault SQLite database, separately from the
pruned HTTP API log. Vault retains the descriptor, signature/public identity
when available, key slot, firmware/device context, a compact transaction
summary, the result, and the error. It deliberately does not retain a seed,
private key, full raw transaction, API credential, or signer secret.

Blocked entries distinguish two cases:

- **Reached device** means the ClearSign request was handed to KeepKey and was
  rejected, cancelled, or failed there.
- **Blocked before transport** means host canonicalization or request
  validation failed first. Keeping these is useful for parser-negative tests,
  but they must not be misreported as a device refusal.

The capture points cover Studio attestation/loading, Vault RPC EVM and Solana
signing, REST EVM and Solana signing/loading, and the Vault swap signing path.
Only the descriptor is retained for transaction events. Hidden/passphrase
wallet sessions keep Vault's existing no-disk-persistence guarantee and do not
write ClearSign evidence.

## Required test matrix

| Test | Expected result |
|---|---|
| Studio action with Advanced Mode off | Host and firmware both reject it |
| Read key with Advanced Mode on | 33-byte compressed key and stable fingerprint |
| Malformed or non-`KKSOLSC1` payload | Rejected without a signature |
| Build the bundled Relay form | Bytes exactly match the SDK/firmware fixture |
| Edit canonical hex, then Inspect | Decodes to the same visible fields or fails closed |
| Valid schema, user cancels any label | No signature returned |
| Load signer, user cancels trust screen | Slot remains empty |
| Disable Advanced Mode after loading | All runtime signer slots are cleared |
| EVM runtime metadata | Decoded screens followed by normal amount/raw review |
| Solana runtime schema | Decoded screens followed by normal Blind Sign warning |
| Reboot, `Initialize`, or `ClearSession` | Runtime signer is gone and schema verification fails |
| Device rejects/cancels a descriptor | Evidence says `blocked` + `reached device` |
| Host rejects malformed descriptor | Evidence says `blocked` + `blocked before transport` |
| ClearSign EVM/Solana Vault or REST tx succeeds | Descriptor appears in Signed evidence |

For release evidence, copy the Studio report and pair it with OLED captures of
the on-device schema review and the additive raw/unverified review.

## Wire surface

| ID | Message |
|---:|---|
| 1700 | `ClearsignAttestorGetPublicKey` |
| 1701 | `ClearsignAttestorPublicKey` |
| 1702 | `ClearsignAttestorSign` |
| 1703 | `ClearsignAttestorSignature` |

The attestation key uses the dedicated hardened derivation path
`m/0x4B4B'/0x4353'/0'`; it is outside coin keyspaces and remains protected by
the device seed and PIN.

Reusable Solana schema fields use `SolanaSignTx` tags 9, 10, and 11. Tags 5-8
belong to the separate transaction-bound swap-metadata path.
