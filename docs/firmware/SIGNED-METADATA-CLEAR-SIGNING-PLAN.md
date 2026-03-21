# Signed Metadata Clear Signing Plan

## Goal

Add a signed metadata path that lets KeepKey render clear, protocol-specific transaction review without hardcoding every protocol into firmware.

This is intended to close the gap between:
- native parser coverage for common transactions
- opaque or blind signing for everything else

The design should work for Ethereum first and extend cleanly to Solana.

## Problem

KeepKey's current firmware can only clear-sign what it can parse locally.

For Ethereum, known cases are either:
- directly parsed in firmware, such as basic ETH and standard ERC-20 flows
- handled by bespoke contract-specific code
- treated as arbitrary contract data and shown with a warning plus raw data review

For Solana, the current branch is even narrower and is still building out native parser coverage.

This does not scale. Ledger's practical advantage is not just more firmware parsers. Their advantage is that trusted metadata can be supplied by the host, verified on device, and then used to render a higher-quality review flow.

KeepKey should adopt the same core idea, but with a simpler architecture:
- one canonical signed payload format
- one on-device verification path
- one policy gate for unverified metadata

## Non-Goals

- Replacing native parsers for simple transfers
- Building a full Ledger-style plugin runtime
- Accepting unauthenticated host-provided display strings
- Solving every DeFi protocol in the first branch
- Introducing a broad online trust dependency into firmware

## Design Summary

Introduce a `SignedMetadata` channel from host to firmware.

The host sends:
- the transaction to sign
- zero or more signed metadata blobs that describe how to review parts of that transaction

The firmware:
1. parses the transaction as it does today
2. attempts native parsing first
3. attempts metadata verification second
4. classifies the request as one of:
   - `VERIFIED`
   - `OPAQUE`
   - `MALFORMED`
5. gates `OPAQUE` signing behind policy

The critical rule is:

No host-provided metadata may influence user-visible semantics unless:
- the metadata signature verifies
- the metadata binds to the actual transaction being signed
- every declared constraint is satisfied on device

## Trust Model

### Root of trust

Firmware ships with one or more pinned metadata verification public keys.

Recommended initial model:
- one production metadata root key
- one test key for development builds only

Optional later model:
- key usage separation for different metadata families:
  - transaction review descriptors
  - token metadata
  - protocol registries

### Signature primitive

Use deterministic ECDSA over `secp256k1` with `SHA-256` for the first implementation.

Why:
- already familiar in the existing codebase
- compact enough
- operationally simple for a host signing service

If firmware-side support is cleaner with another existing primitive already present in the codebase, that can be revisited. The important property is canonical serialization plus strict verification.

### Verification rule

The firmware never trusts the host session.

It only trusts:
- firmware-embedded public keys
- metadata signatures that verify against those keys
- constraints that it can recompute from the transaction bytes

## Classification Model

Keep the policy split explicit:

- `VERIFIED`
  - native parser review or metadata-backed review succeeded
  - normal confirmation flow
- `OPAQUE`
  - transaction is structurally valid, but semantics are not fully verified
  - gated by policy
- `MALFORMED`
  - transaction or metadata is invalid, inconsistent, or unsafe
  - reject

Recommended policy naming:
- keep `AdvancedMode` for current arbitrary-data behavior
- add a dedicated policy later for explicit blind signing, such as `EthereumBlindSigning` and `SolanaBlindSigning`

The first branch does not require a storage migration if `AdvancedMode` is kept as the temporary gate.

## Metadata Object Model

The firmware should not receive free-form display text as the primary source of truth.

Instead it should receive canonical descriptors with typed fields.

Recommended top-level object:

- `SignedTxMetadata`

Fields:
- `version`
- `chain_type`
- `chain_id` or network discriminator
- `tx_hash_mode`
- `tx_hash`
- `descriptor_count`
- `descriptors[]`
- `expires_at` or `valid_until_block`
- `key_id`
- `signature`

Recommended descriptor types:
- `TransferDescriptor`
- `ApprovalDescriptor`
- `SwapDescriptor`
- `StakeDescriptor`
- `CallDescriptor`
- `AtaCreateDescriptor`
- `ComputeBudgetDescriptor`

Each descriptor should contain:
- typed semantic fields to display
- exact bindings to transaction fields
- explicit constraints the firmware can validate

Example constraints:
- destination address must equal transaction callee
- spender must equal ABI parameter `arg0`
- amount must equal ABI parameter `arg1`
- token contract must equal transaction `to`
- function selector must match expected selector
- Solana instruction program id and account indices must match

The descriptor is not an alternative transaction. It is a signed claim about how to interpret the actual transaction.

## Canonical Serialization

This is the most important design detail.

The signed bytes must be canonical and unambiguous.

Requirements:
- fixed field ordering
- explicit lengths
- explicit integer endianness
- no optional field ambiguity
- no duplicate field acceptance
- no lossy text normalization

Recommended first implementation:
- a compact binary TLV or length-prefixed struct format

Do not start with JSON inside firmware.

JSON can still be used by backend tools, but it should be compiled into canonical binary before signing.

## Transaction Binding

The metadata signature alone is not enough.

The metadata must bind tightly to the transaction.

Recommended binding:
- sign metadata over the transaction signing payload hash, not just a protocol identifier

Examples:
- Ethereum: hash over the exact unsigned transaction payload being approved
- Solana: hash over the exact message bytes being signed

If exact full-tx binding is too strict for some reusable descriptors, allow constrained bindings, but only in a later phase.

Phase 1 should use strict binding:
- one signed metadata package per transaction

This keeps the attack surface small.

## Firmware Flow

### Common flow

1. Host sends transaction plus optional signed metadata blob
2. Firmware parses the transaction bytes
3. Firmware computes the transaction signing hash or message digest
4. Firmware verifies the metadata signature
5. Firmware checks metadata version, chain, expiry, and key id
6. Firmware validates every descriptor constraint against the actual transaction
7. Firmware selects review mode:
   - native verified review if local parser covers it
   - metadata verified review if signed metadata matches
   - opaque review if transaction is valid but unverified
   - reject if malformed

### Ethereum flow

Priority order:
- existing native ETH and ERC-20 logic
- signed metadata for contract interactions
- opaque contract-data warning

Metadata-backed Ethereum review should initially support:
- token approvals
- swaps
- contract calls with amount plus recipient semantics
- Permit / Permit2 style approvals only after typed constraints are mature

### Solana flow

Priority order:
- native parser coverage for System, Stake, Token, ATA, ComputeBudget, Vote
- signed metadata for protocol-specific instruction bundles
- opaque fallback for unresolved but structurally valid transactions

Metadata-backed Solana review should initially support:
- known program bundles
- swap/profile flows
- versioned transactions whose semantics are only partially native-parsed

## Recommended Firmware Interfaces

### New transport messages

Add a small new protobuf family for signed metadata transport.

Recommended messages:
- `TxMetadataChunk`
- `TxMetadataAck`

Alternative:
- add optional metadata fields to chain-specific signing requests

Recommendation:
- keep the metadata transport generic rather than chain-specific
- attach it to the active signing session

That avoids duplicating the transport design across Ethereum and Solana.

### New firmware modules

Recommended new files:
- `modules/keepkey-firmware/include/keepkey/firmware/signed_metadata.h`
- `modules/keepkey-firmware/lib/firmware/signed_metadata.c`
- `modules/keepkey-firmware/lib/firmware/signed_metadata_ethereum.c`
- `modules/keepkey-firmware/lib/firmware/signed_metadata_solana.c`

Responsibilities:
- canonical payload parsing
- signature verification
- transaction binding checks
- descriptor validation
- generation of review items for UI

### Integration points

Ethereum:
- [modules/keepkey-firmware/lib/firmware/fsm_msg_ethereum.h](/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/modules/keepkey-firmware/lib/firmware/fsm_msg_ethereum.h)
- [modules/keepkey-firmware/lib/firmware/ethereum.c](/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/modules/keepkey-firmware/lib/firmware/ethereum.c)

Solana:
- the current Solana signing FSM and parser path in `solana.c` and corresponding FSM handlers

Storage and policy:
- [modules/keepkey-firmware/include/keepkey/firmware/policy.h](/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/modules/keepkey-firmware/include/keepkey/firmware/policy.h)
- storage policy plumbing if dedicated blind-signing toggles are introduced

## UI Model

The metadata system should produce a small, normalized list of review items.

Example item types:
- action
- asset
- amount
- spender
- recipient
- protocol
- fee note
- warning

Firmware should render from these normalized items, not from arbitrary host text blobs.

Example:

Instead of:
- "Approve Uniswap V4 Router to spend 1,000 USDC on Base"

Prefer validated fields:
- Action: Approve
- Spender: Uniswap V4 Router
- Amount: 1,000 USDC
- Token: USDC
- Network: Base

This keeps the rendering layer simple and makes partial verification explicit.

## Security Requirements

The design should enforce the following:

- No unsigned metadata changes transaction semantics on device
- Metadata must be chain-specific
- Metadata must be versioned
- Metadata must be replay-bounded where practical
- Descriptor constraints must be exhaustive for any field shown as trusted
- Unknown descriptor versions must fail closed
- Duplicate descriptors for the same semantic slot must fail closed
- Truncated or oversized metadata must fail closed

Additional hard rules:

- If a field is shown without local validation, label it as unverified or omit it
- Human-readable names must never override validated addresses
- Metadata must never change the actual bytes being signed

## Host / Backend Architecture

Keep this simple in phase 1.

### Recommended host pipeline

1. Vault or CLI builds the unsigned transaction
2. Host computes the exact signing payload hash
3. Host requests signed metadata from a descriptor service
4. Service returns canonical binary metadata plus signature
5. Host sends transaction and metadata to device
6. Device verifies and renders

### Descriptor service responsibilities

- canonicalize transaction facts into a descriptor request
- map known protocols into typed review descriptors
- sign only descriptors that satisfy backend policy
- return compact metadata suitable for device transport

The service can be local, bundled, or remote.

For production, a remote signing service is operationally simplest because:
- protocol descriptors evolve quickly
- compromised descriptors can be revoked by rotating metadata keys in new firmware

## Phase Plan

### Phase 0: Document and lock the trust model

- define threat model
- define classification model
- define canonical serialization
- define key management expectations

Deliverable:
- this design doc plus wire-format notes

### Phase 1: Ethereum transaction-bound metadata MVP

- add generic metadata transport
- add one pinned metadata verification key
- add canonical binary parser
- add signature verification
- bind metadata to exact unsigned Ethereum transaction hash
- support one or two descriptor types:
  - `ApprovalDescriptor`
  - `CallDescriptor`
- render normalized review screens from verified metadata
- fall back to current arbitrary-data warning if metadata is absent or invalid

Deliverable:
- signed clear-sign review for selected contract calls without changing existing native ETH paths

### Phase 2: Solana transaction-bound metadata MVP

- reuse generic transport and verifier
- bind metadata to exact Solana message bytes
- support one or two bundle descriptors:
  - `AtaCreateDescriptor`
  - `SwapDescriptor`
- preserve native parser precedence
- classify unresolved transactions as `OPAQUE`

Deliverable:
- verified review for selected Solana protocol flows that exceed native parser coverage

### Phase 3: Dedicated blind-signing policy split

- add explicit policy flags:
  - `EthereumBlindSigning`
  - `SolanaBlindSigning`
- migrate chain-specific opaque gating away from `AdvancedMode`
- tighten default behavior for metadata failures

Deliverable:
- clearer user policy model

### Phase 4: Descriptor registry maturity

- support multiple metadata keys with key ids
- support key rotation
- support descriptor family versioning
- add tooling for signing and regression tests

Deliverable:
- maintainable production system

## Testing Strategy

### Unit tests

- canonical serialization round-trips
- signature verification success and failure
- expiry handling
- descriptor constraint matching
- fail-closed behavior for malformed payloads

### Firmware integration tests

- ETH tx with valid metadata renders verified review
- ETH tx with invalid signature falls back to opaque or rejects
- Solana tx with mismatched metadata rejects
- replayed metadata for different tx hash rejects

### Adversarial tests

- swap target changed after descriptor signing
- selector matches but amount differs
- trusted name differs from validated address
- duplicate fields and duplicate descriptors
- oversized payloads and chunking edge cases

## Open Questions

- Whether to use a generic metadata transport message or chain-specific optional fields
- Whether to keep `secp256k1` for metadata signing or use another existing verification primitive already better supported in firmware
- Whether the first production deployment should use one global metadata key or separate keys per descriptor family
- Whether metadata expiry should be wall-clock based, block-height based, or omitted in phase 1

## Recommended Immediate Implementation Order

1. Define the canonical binary schema for `SignedTxMetadata`
2. Add a small standalone firmware verifier module
3. Add a transaction-bound Ethereum MVP path behind current arbitrary contract review
4. Add unit tests for invalid signature, wrong tx hash, and wrong selector
5. Add host-side tooling to build and sign metadata fixtures
6. Extend the same verifier path to Solana

## Bottom Line

KeepKey can adopt the useful part of Ledger's model without copying Ledger's full architecture.

The right target is not "all protocol logic in firmware."

The right target is:
- native parsing for common transactions
- signed metadata for rich protocol review
- strict fallback to opaque or reject when trust is insufficient

That gets KeepKey closer to practical clear-signing parity while keeping firmware complexity under control.
