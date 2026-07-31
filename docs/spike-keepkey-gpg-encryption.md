# Design spike: GPG encryption powered by KeepKey

**Date:** 2026-07-08
**Goal:** let anyone encrypt something (a file, a note, an email) to a KeepKey user using ordinary, standards-compliant GPG/OpenPGP — no special client software required on the sender's side — such that only that user's KeepKey can decrypt it. This is a generic capability, not tied to any one internal feature; a "KeepKey GPG Mail" product (receive normal PGP-encrypted email, decrypt it by plugging in your device) falls out of it as a natural byproduct once the core capability exists.

## Bottom line up front

**The public-key half of this is basically already possible today, with zero firmware changes.** The private-key half (on-device decryption) needs new, narrowly-scoped firmware work — smaller than initially assumed, because the sender doesn't need any KeepKey-specific software at all if the scheme is genuinely OpenPGP-standard.

## What's real today (verified by reading `keepkey-firmware` directly, not docs)

**`GetPublicKey` already supports arbitrary curves, not just secp256k1.** `lib/firmware/fsm_msg_coin.h`:
```c
const char* curve = coin->curve_name;
if (msg->has_ecdsa_curve_name) {
  curve = msg->ecdsa_curve_name;   // caller-selectable
}
```
And the curve constants `NIST256P1_NAME` and `ED25519_NAME` (`include/keepkey/crypto/curves.h`) are real and already used elsewhere in firmware for other coins (Nano/Solana-family use ed25519; other assets use nist256p1). This matters because **OpenPGP's standard ECC curve set is NIST P-256/P-384/P-521 (RFC 6637) plus Ed25519/Curve25519 (modern GnuPG default, RFC 9580)** — it does *not* include secp256k1 (Bitcoin's curve). So a KeepKey can export a public key on a curve OpenPGP actually recognizes, today, via an already-implemented, already-shipped message. This is the opposite of the earlier finding about `CipherKeyValue` (hardcoded to `SECP256K1_NAME`, wrong curve family for OpenPGP) — that primitive was a dead end for this use case; `GetPublicKey` on `nist256p1`/`ed25519` is not.

**What's still missing, and why it's smaller than it first looked:** OpenPGP's ECDH encryption scheme (RFC 6637) works by the *sender's* software generating an ephemeral key, doing ECDH against the recipient's long-term public key, deriving a symmetric key, and using it to wrap the real message session key — all standard, all already implemented in every GPG tool that exists. The recipient's device only ever needs to do one thing to decrypt: **given the sender's ephemeral public key, run ECDH against the device's own private key at the right path, and return the shared secret** (the host app finishes unwrapping the session key and decrypting the message body — plain OpenPGP packet parsing, not device-side). That one operation — device-side ECDH — is exactly what's missing:

- `EncryptMessage`/`DecryptMessage` (`device-protocol/messages.proto`) is protocol-declared but its firmware dispatch is explicitly commented out (`messagemap.def`: `/* ECIES disabled ... */`) with no implementation ever written.
- `GetECDHSessionKey` (the more directly-relevant Trezor-legacy primitive — literally "do ECDH, return the session key") **does not exist in KeepKey's protocol at all**, not even declared.

**Open question worth resolving before writing firmware code:** the ECIES pair being explicitly commented out (not just unfinished) suggests a deliberate decision to disable it. Find out why — check `keepkey-firmware` history around that comment and whether upstream Trezor made the same call and, if so, for what reason — before reviving or redesigning around it. Reusing old disabled crypto code without understanding why it was turned off is how a hardware wallet gets a real vulnerability, not just a missing feature.

## What a real implementation needs

1. **Key export (today, no firmware change):** `GetPublicKey` at a fixed, purpose-specific BIP32 path with `ecdsa_curve_name: "ed25519"` (or `"nist256p1"`), returning a real public key on an OpenPGP-standard curve.
2. **Valid OpenPGP certificate construction (needs confirming, likely small):** turning that raw public key into a proper OpenPGP transferable public key packet requires a self-signature binding the key to a User ID (name/email). This needs the device to sign an arbitrary digest with a non-Bitcoin-curve key — check whether a generic "sign this digest with this path+curve" primitive already exists (distinct from Bitcoin/altcoin transaction signing) before assuming new firmware is needed here too.
3. **Device-side ECDH for decryption (real firmware work):** implement an ECDH primitive (new — nothing to revive, `GetECDHSessionKey` doesn't exist) or design/implement `DecryptMessage` properly, after resolving the "why was ECIES disabled" question above. Scope is narrow — one operation, not a full cipher — but it's still new cryptographic surface in trusted firmware and should get a security review, not just a functional one, before shipping.
4. **New signed firmware release** — real release engineering (notarized/signed builds per this stack's conventions), gated on the security review above.
5. **SDK layer:** a new `hdwallet-keepkey` method wrapping the ECDH call (mirroring the existing `cipherKeyValue()` pattern).
6. **App layer (`keepkey-vault-v11`):** a REST endpoint wiring the new SDK call, plus a UI flow for "paste/drop a PGP-encrypted message here, plug in your device, decrypt it" — and, for the export side, a way to view/publish the user's KeepKey-derived OpenPGP public key (QR code, keyserver upload, or just a copy-able ASCII-armored block) so others can encrypt to it using their own ordinary GPG tools.

## The "GPG mail" byproduct

Because step 1 already works and the scheme is genuinely OpenPGP-standard (not a KeepKey-proprietary format), the moment step 3 ships, anyone can encrypt an email to a KeepKey user's exported public key using Thunderbird/ProtonMail/GnuPG/whatever they already use — no custom sender-side tooling required. That's a real, differentiated customer feature ("your hardware wallet is also your PGP decryption key"), not a side effect that needs separate engineering — it falls out of building the generic capability correctly.

## Recommendation

Treat this as a firmware-track project, not an app-layer spike: the real unknowns are (a) why ECIES was disabled originally, and (b) whether a generic non-Bitcoin-curve signing primitive already exists for step 2. Resolve both before scoping firmware implementation work or committing to a timeline.
