# Clear-sign certificate chains — spec (DRAFT, needs security-model review)

**Status:** proposal. Nothing here is implemented. §4 of
`docs/handoff-clearsign-attestor-and-trust-model.md` requires this document to be
reviewed by whoever owns the firmware security model *before* any code lands —
firmware PR #322 is the demonstration of what skipping that step costs.

**Problem.** Trusting a provider today means baking their pubkey into firmware:
`METADATA_MAX_KEYS = 4`, direct slot lookup in `metadata_pubkey_for()`. That is a
firmware release per customer with a hard ceiling of four. It is not a B2B
onboarding path.

**Shape.** One KeepKey root key, baked into signature-protected firmware, signs a
small certificate per provider. The device verifies root → provider →
metadata. Onboarding becomes *issuing a certificate*. The root lives in the
issuing KeepKey's seed (firmware PR #323, `m/0x4B4B'/0x4353'/0'`).

---

## 1. Certificate format

Fixed-layout binary. No ASN.1, no X.509, no DER — the parser is the attack
surface and this one has to fit next to a 4-10KB ROM margin.

```
offset  size  field
0        8    magic         "KKCSCERT"
8        1    version       = 1
9        1    root_id       which baked root signed this (see §4)
10      33    subject_key   compressed secp256k1, the provider's attestation key
43       2    usage         BE bitfield, see §2
45       4    serial        BE, monotonic per root. The revocation handle.
49       4    not_after     BE unix seconds, 0 = none. NOT ENFORCED in v1, see §3.
53       1    label_len     1..31
54     ...    label         printable ASCII, same character rules as the signer
                            alias (no '%'). Shown on the per-tx screen.
       64     signature     root ECDSA, 64-byte compact over sha256(bytes 0..N-65)
```

Max 149 bytes. Verification is one `sha256_Raw` + one `ecdsa_verify_digest` —
the same two calls `signed_metadata_verify_attestation` already makes. The field
readers (`read_u8`, `read_be_u32`, `read_bytes`, `read_string`) already exist as
statics in `signed_metadata.c`.

**Chain depth is exactly one.** Root signs provider, provider signs metadata. No
intermediate CAs, no path building, no depth limit to get wrong. If a customer
needs to delegate further, they run their own issuing KeepKey and we certify
that key — the recursion happens in their org chart, not in the parser.

**Certificates are not stored on the device.** The cert travels with the metadata
blob in the same message (a new optional `certificate` field) and is verified per
transaction. Nothing new is written to flash. This is deliberate: the entire
lesson of the rejected persistence PR is that public flash is not a place for
trust anchors.

## 2. Key-usage scoping — mandatory, not a later refinement

Today *any* trusted key can attest *any* metadata type: `signed_metadata_process`
(EVM v1/v2), the KKSOLSC1 schema path in `fsm_msg_solana.h`, and
`solana_token_info_trusted` all resolve through the same
`metadata_pubkey_for(key_id)` with no notion of what the key is *for*.

With one baked key and four manually loaded slots that is tolerable. With
certificates issued per customer it is not: a provider certified to describe
Solana swap instructions could attest EVM contract methods, or forge a token
definition, for any user.

```
bit 0   EVM signed metadata (v1 legacy + v2 schema)
bit 1   Solana KKSOLSC1 instruction schemas
bit 2   Solana signed token definitions
bits 3-15  reserved, MUST be zero in v1 (reject non-zero — an unknown bit is an
           unknown permission)
```

Enforced at each call site, not centrally, so a new consumer of the keyring
cannot silently inherit blanket trust: the verifier takes a required-usage
argument and fails closed if the certificate does not carry that bit.

This was flagged in independent research of Ledger's implementation. It is cheap
now and expensive after certificates are in the field.

## 3. Revocation — honest limits

The device has no network and no clock. That rules out OCSP, CRL fetch, and
enforceable expiry. Two mechanisms, neither pretty:

**`not_after` is carried but not enforced in v1.** There is no trusted time
source. A host-supplied timestamp is host-controlled and therefore worthless; an
RTC does not exist. The field is in the format so that enforcement can be added
if a trusted time source ever appears, and so that issued certificates already
carry the intended lifetime. **Do not enforce it against a host-supplied value.**

**Revocation is a firmware-baked serial denylist.** `serial` is 4 bytes; a
denylist of revoked serials costs 4 bytes each versus 33 for a baked key, and it
is an exception list rather than the allowlist — so the common case (adding a
customer) stays release-free and only the rare case (burning a compromised
provider) needs a release.

**State this plainly to customers:** revoking a compromised provider key requires
a firmware release, and users who do not update stay exposed. That is a real
weakness of the design and it should be written into the B2B agreement rather
than discovered later. It is still strictly better than today, where *adding* a
provider also requires a release.

## 4. Root rotation

Two baked root slots, `root_id` 0 and 1, both accepted. Rotation:

1. Release firmware carrying old root (slot 0) and new root (slot 1).
2. Re-issue provider certificates under slot 1.
3. A later release drops slot 0.

`root_id` is in the certificate so the device does not have to trial-verify
against every root, and so a certificate cannot be silently reinterpreted under a
different root. Two slots is the minimum that makes rotation possible without a
flag day; more slots is more standing trust for no benefit.

**Root compromise is a firmware release.** Accepted — the root lives in a seed on
a KeepKey that never touches a network, and the whole point of §4 of the handoff
is that it is not on a server.

## 5. Display

A certificate-verified signer is a trusted tier — no warning screen — but the
device **always shows the label**: "Verified by Acme Trust" plus the subject-key
fingerprint, using the existing `signed_metadata_pubkey_fingerprint()`. A user
who cannot see who vouched for the decode cannot tell a legitimate provider from
a certified-then-compromised one, and the fingerprint is what makes the two
distinguishable after a public disclosure.

## 6. What this does NOT change

- `AdvancedMode` still shows raw calldata. A matched certificate, like a matched
  signer today, replaces the raw-data screen — which is exactly why the
  certificate must be verified against a *baked* root and never a
  flash-persisted one. See §3 of the handoff.
- Runtime-loaded signers (`LoadClearsignSigner`) keep their warning-first
  treatment. Certificates are an additional path, not a replacement.
- No new storage records. V18 stays scrubbed.

## 7. Open for the reviewer

1. Is a release-gated revocation path acceptable for the B2B contracts we intend
   to sign, or does that requirement change the design?
2. Should the usage bitfield be per-chain (bit per chain) instead of per-format?
   Per-format is fewer bits and matches how the verifiers are actually
   structured, but a provider certified for "EVM signed metadata" is certified
   for every EVM chain at once.
3. ROM: certificate parse + verify + usage enforcement is estimated at well under
   1KB, but the 7.15 line is 4-10KB from the wall. Does this land in 7.15, or
   does it wait for the `tokens` 31KB reduction?
4. Who holds the issuing KeepKey, and what is the physical procedure for using
   it? The spec assumes it exists; it does not describe custody.
