# Handoff: expose ClearSign reports to KeepKey Client

Date: 2026-09-21
Producer: KeepKey Vault
Consumer: KeepKey Client browser extension and side panel

## Goal

KeepKey Client should render the same transaction meaning, identities, effects,
warnings, limitations, and evidence sources that Vault uses. Vault remains the
source of truth. The client must not copy the Uniswap, Permit2, token, or
simulation decoders.

## Available preflight endpoint

`POST http://localhost:1646/clearsign/report`

Authentication uses the same bearer token as the signing endpoints:

```http
Authorization: Bearer <vault pairing token>
Content-Type: application/json
```

EVM request:

```json
{
  "chain": "evm",
  "chainId": 42161,
  "from": "0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E",
  "to": "0x2d01411773c8c24805306e89a41f7855c3c4fe65",
  "data": "0x3593564c...",
  "value": "0x0",
  "nonce": "0x2",
  "gas": "0x5f4ec",
  "maxFeePerGas": "0x1cab998",
  "maxPriorityFeePerGas": "0x0"
}
```

Solana request:

```json
{
  "chain": "solana",
  "raw_tx": "<base64 transaction>",
  "owner": "<base58 owner>"
}
```

The endpoint is read-only and never opens the device or signs. Its response is
a `ClearSignReport` directly, not a `{ data: ... }` wrapper.

## Current version 1 response

```ts
type ProtectionLevel = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5'

interface ClearSignReport {
  version: 1
  generatedAt: number
  chain: 'Ethereum' | 'Solana'
  transactionFingerprint: string
  protectionLevel: ProtectionLevel
  headline: string
  descriptor: {
    source: 'none' | 'native' | 'erc7730' | 'runtime' | 'certified'
    authenticated: boolean
    format?: 'ERC7730' | 'EVM_METADATA' | 'KKSOLSC1' | 'FIRMWARE_NATIVE'
    label?: string
    artifactHash?: string
    codeIdentityBound?: boolean
    expiresAt?: number
    resolution?: string
  }
  simulation: EffectReport
  findings: EffectFinding[]
  limitations: EffectFinding[]
  claims: Array<{
    source: 'transaction-bytes' | 'authenticated-definition' | 'simulation'
    statement: string
  }>
}
```

Use the checked-in definitions as canonical until they are published through
`keepkey-vault-sdk`:

- `projects/keepkey-vault/src/shared/clearsign-report.ts`
- `projects/keepkey-vault/src/shared/transaction-effects.ts`
- `projects/keepkey-vault/src/bun/schemas.ts` (`ClearSignReportRequest`)

## Required Vault API completion

Preflight reports intentionally do not claim that the device has authenticated
metadata. To give the client full parity with Vault, add the following additive
contract before the client integration is declared complete:

1. Successful signing responses include `clearSignReport` alongside the existing
   signature/serialized transaction fields.
2. That final report is the exact report approved in Vault, updated only with
   the actual device metadata result.
3. The final report retains the same `transactionFingerprint` returned by
   preflight. Vault rejects signing if the normalized request fingerprint differs.
4. Rejection and policy-block responses may include `clearSignReport` so the
   client can explain why signing was refused, but never include signatures.
5. Add `deviceVerification` as an optional version-1 field or introduce report
   version 2:

```ts
interface DeviceVerification {
  status: 'not-attempted' | 'verified' | 'rejected' | 'unsupported' | 'error'
  firmwareVersion?: string
  signerFingerprint?: string
  metadataFormat?: string
}
```

The recommended implementation is report version 2 because device verification
changes the meaning of P4/P5 from an expected capability to an observed result.

## KeepKey Client work

1. Add a typed `getClearSignReport(request)` helper next to the existing Vault
   REST client. Use the saved pairing token and a bounded timeout.
2. In `ethereumHandler.ts`, call preflight after the final transaction fields
   are fixed and before calling the signing endpoint. Do not preview an earlier
   gas, nonce, recipient, value, or calldata draft.
3. Add the same call to the Solana path after the final wire transaction is
   built and before signing.
4. Pass the report through the background-to-side-panel message boundary.
5. Render `headline`, protection level, findings, limitations, asset changes,
   authority changes, fee, descriptor label, and claims. Show full addresses.
6. Compare the signing response fingerprint to the preflight fingerprint. Treat
   a mismatch as an internal error and do not broadcast.
7. Never infer a higher protection level in the client. Render the level Vault
   returned.

## Display behavior

- P4/P5: authenticated description styling, with the descriptor identity and
  device-verification state visible.
- P3: simulation styling that clearly says effects are predictions.
- P2: decoded transaction bytes, unauthenticated.
- P1: unknown/blind review warning.
- P0: blocked; do not expose a sign action.
- `danger` findings remain prominent even for P4/P5. Authentication proves who
  described the action; it does not make an unlimited allowance harmless.

Do not show raw implementation terms such as schema key slots, worker secrets,
or certificate encodings in the normal user flow.

## Acceptance tests

1. Arbitrum USDT approval names USDT and Permit2 with full addresses.
2. Permit2 typed data names the official Uniswap Universal Router and limits the
   warning to Arbitrum USDT while preserving unlimited amount and expiry.
3. Reviewed Uniswap V3 and V4 routes show input, maximum spend, output, minimum
   receive, recipient, deadline, router identity, and network.
4. Mutating one transaction byte changes the fingerprint and cannot reuse the
   earlier report.
5. Unknown selectors stay P1 and cannot be restyled as verified by the client.
6. Simulation failure remains visible even when the description is authenticated.
7. The client refuses broadcast when preflight and final fingerprints differ.

## Completion criterion

This handoff is complete when the client displays the API report for EVM and
Solana, the final signing response carries observed device verification, and an
end-to-end test proves that the previewed, approved, device-reviewed, signed,
and broadcast transaction fingerprints are identical.

