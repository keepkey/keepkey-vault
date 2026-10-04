# ClearSign architecture and ownership

Date: 2026-09-21
Status: decision for the next implementation phase

## Decision

ClearSign is a protocol with several independently reviewable components. It is
not a contract catalog embedded in firmware and it is not a second transaction
decoder implemented by every KeepKey client.

| Component | Owns | Must not own |
|---|---|---|
| KeepKey firmware | Root/delegate verification, bounded metadata interpreters, signed-byte binding, device rendering, refusal policy | Network access, mutable contract catalogs, host simulation |
| KeepKey Vault | Canonical `ClearSignReport`, request normalization, artifact resolution, simulation, signing orchestration, REST API, audit observations | Independent claims that the device verified metadata before it did |
| ClearSign service | Reviewed definitions, chain certificates, on-demand identity verification, transaction-bound descriptions, revocation and provenance | Wallet keys, user authorization, transaction broadcast |
| KeepKey Client and other wallets | Render the Vault report, preserve its evidence labels, submit the exact transaction that was previewed | Reclassifying P1 as P4, duplicating protocol decoders, trusting dApp labels as identity |
| Pioneer and public registries | Discovery candidates, RPC/state evidence, ecosystem inventory | Final authentication authority |

## Repository placement

The current implementation remains in this monorepo while the API stabilizes:

- Firmware verification and display code: `modules/keepkey-firmware`.
- Host report, simulation, resolution, and protocol decoders:
  `projects/keepkey-vault/src`.
- Production worker source and tests:
  `projects/keepkey-vault/clearsign-worker`.
- Public REST request/response schemas: `projects/keepkey-vault/src/shared` and
  `projects/keepkey-vault/src/bun/schemas.ts`.
- Case studies and operational evidence: `docs/clearsign-case-studies`.
- Generated ecosystem inventories: local or release artifacts, not Git history.

After the report contract reaches version 2, extract only the wire types and
pure validation helpers into a small package published with
`keepkey-vault-sdk`. Do not move signing keys, worker policy, database code,
simulation providers, or firmware parsers into that package.

The worker may later become a dedicated deployment repository. Its source must
remain reproducibly tied to a reviewed commit, certificate set, and deployment
version. Moving it before the API and promotion model stabilize would split one
active trust-boundary migration across repositories without reducing risk.

## Data flow

1. A client sends the complete unsigned transaction to Vault.
2. Vault normalizes it and computes the transaction fingerprint.
3. Vault resolves authenticated metadata and obtains simulation evidence.
4. Vault returns one evidence-labelled `ClearSignReport` for client rendering.
5. The client submits the exact same transaction for signing.
6. Vault rejects a fingerprint mismatch and presents the same report in its
   approval window.
7. Firmware independently verifies the description and signed transaction.
8. The signing response returns the final report with the actual device result.

The transaction fingerprint is the join key between preview, Vault approval,
device review, signature response, and later audit records.

## Compatibility rule

Consumers switch on `version` and preserve unknown fields. New optional fields
may be added to a report version. Removing fields, changing their meaning, or
changing enum values requires a new version. A client that does not understand
a version may show a generic review but must not upgrade its protection level.

## Security rule

The report distinguishes three sources:

- `transaction-bytes`: deterministic facts parsed from the signed request;
- `authenticated-definition`: descriptions authorized by firmware trust roots;
- `simulation`: state-dependent predictions from an identified provider head.

Clients must retain those labels. Simulation never authenticates a contract,
and host recognition never proves that the device accepted a description.

