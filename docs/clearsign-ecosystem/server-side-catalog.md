# Server-side ClearSign catalog updates

## Goal

Ship reviewed ClearSign definitions without requiring a Vault release, while
preserving the device as the final verifier and keeping a compromised online
service from silently redefining a transaction.

## Current constraint

Vault first matches every Solana transaction against its compiled
`CERTIFIED_SOLANA_CATALOG`. Only a unique local match is sent to the ClearSign
Worker. The Worker returns a signed schema and the device verifies that schema,
but Vault then compares the response with the same compiled entry. This local
allowlist is why a Worker deployment alone cannot add an operation today.

Removing the local match would make updates immediate, but it would also let
the Worker's online delegate key author arbitrary definitions. That is too much
authority for an internet-facing service.

## Proposed trust split

1. Create a versioned canonical catalog manifest. Each entry contains the
   serialized device schema, exact program/contract identity, discriminator,
   covered length, account requirements, companion policy, provenance, risk
   metadata, minimum firmware version, and an immutable entry ID.
2. Sign manifest entries offline with a catalog-review key. Do not place this
   key in Worker secrets. Publish the signature, reviewer identity, sequence,
   validity window, and previous-manifest hash.
3. Teach Vault to fetch and cache the manifest, verify its signature and hash
   chain against an embedded catalog root, parse the serialized schema, and run
   the existing generic transaction-match rules locally. Vault must never trust
   unsigned names or fields returned by the Worker.
4. Serve pre-signed static schema blobs from the Worker. Keep the online
   attester limited to dynamic facts that cannot be pre-signed, such as a
   resolved lookup-table snapshot or verified token metadata. Give that key a
   distinct scope and expiry.
5. Have firmware verify the static catalog signature and any separately scoped
   dynamic attestations. Until firmware supports that split, deploy only
   pre-signed schemas produced by the existing reviewed delegate ceremony;
   never let the Worker generate a new static schema from request data.
6. Add rollback protection and revocation: monotonic manifest sequence,
   last-known-good cache, explicit revoked entry IDs, short validity for dynamic
   proofs, and fail-closed behavior when verification or freshness fails.
7. Publish every manifest and signature to an append-only transparency log so
   a server deployment cannot present different definitions to different users.

## Migration

- Phase 1: generate signed static entries in CI, deploy them with the Worker,
  and retain Vault's compiled catalog as a required mirror.
- Phase 2: add manifest parsing/signature verification to Vault and operate in
  compare mode, requiring remote and compiled entries to agree.
- Phase 3: after firmware and Vault verify the offline catalog authority,
  permit remote-only entries and keep the compiled catalog solely as an
  emergency fallback.
- Phase 4: move dynamic attestations to their own constrained key and add
  manifest revocation plus transparency monitoring.

The key principle is that definitions may be delivered server-side, but they
must be authored and signed through an offline review path. The Worker is a
distribution and dynamic-proof service, not the source of truth.
