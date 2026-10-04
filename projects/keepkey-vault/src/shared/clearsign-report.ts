import type { ClearSignDefinitionSource, ClearSignProtectionLevel, SolanaTxDecodedInfo } from './types'
import type { EffectFinding, EffectReport } from './transaction-effects'

export interface ClearSignDescriptorEvidence {
  source: ClearSignDefinitionSource
  authenticated: boolean
  format?: 'ERC7730' | 'EVM_METADATA' | 'KKSOLSC1' | 'FIRMWARE_NATIVE'
  label?: string
  artifactHash?: string
  codeIdentityBound?: boolean
  expiresAt?: number
  resolution?: 'selected' | 'invalid-request' | 'no-artifact' | 'shape-mismatch' | 'revoked' | 'expired'
    | 'identity-unavailable' | 'identity-stale' | 'identity-changed' | 'identity-mismatch' | 'unsupported-alt'
}

/** Two EIP-712 approvals of the clearsign definition (device schema) for
 * one audited deployment, verified by Vault. Decides clearsign; no opinion. */
export interface ClearSignDefinitionReview {
  requestId: string
  auditId: string
  evidenceHash: string
  publishedAt: number
  /** Contract + EIP-1967 targets as audited; signing re-measures these. */
  auditedIdentities: Array<{ role: string; address: string; codeHash: string }>
  stateReference: string
  /** False until this Vault pins approver addresses; signatures still verify. */
  approversPinned: boolean
  approvals: Array<{ role: string; reviewer: string }>
}

/** A human auditor's EIP-712-signed opinion of the contract, checked by this
 * app only. Never shown to or checked by the device; never gates clearsign. */
export interface ContractRating {
  network: string
  contract: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  riskReasons: string[]
  findings: Array<{ severity: string; title: string; detail: string; reference?: string }>
  ratedAt: number
  rater: string
  raterPinned: boolean
}

/** The single object consumed by Vault approval UI, evidence storage, and API. */
export interface ClearSignReport {
  version: 1
  generatedAt: number
  chain: 'Ethereum' | 'Solana'
  transactionFingerprint: string
  protectionLevel: ClearSignProtectionLevel
  headline: string
  descriptor: ClearSignDescriptorEvidence
  simulation: EffectReport
  findings: EffectFinding[]
  limitations: EffectFinding[]
  claims: Array<{
    source: 'transaction-bytes' | 'authenticated-definition' | 'simulation'
    statement: string
  }>
  definitionReview?: ClearSignDefinitionReview
  rating?: ContractRating
}

const LEVEL_ORDER: ClearSignProtectionLevel[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5']

function minLevel(a: ClearSignProtectionLevel, b: ClearSignProtectionLevel): ClearSignProtectionLevel {
  return LEVEL_ORDER.indexOf(a) <= LEVEL_ORDER.indexOf(b) ? a : b
}

export function buildClearSignReport(input: {
  requestedLevel: ClearSignProtectionLevel
  descriptor: ClearSignDescriptorEvidence
  simulation: EffectReport
  hostFindings?: EffectFinding[]
  hostLimitations?: EffectFinding[]
  definitionReview?: ClearSignDefinitionReview
  rating?: ContractRating
  now?: number
}): ClearSignReport {
  const { descriptor, simulation } = input
  let protectionLevel = input.requestedLevel

  // P4/P5 are statements about authenticated metadata, never about how good a
  // host simulation looks. A caller cannot promote itself by setting a level.
  if ((protectionLevel === 'P4' || protectionLevel === 'P5') && !descriptor.authenticated) {
    protectionLevel = simulation.status === 'success' ? 'P3' : 'P1'
  }
  if (protectionLevel === 'P5' && !descriptor.codeIdentityBound) protectionLevel = 'P4'
  if (descriptor.expiresAt !== undefined && descriptor.expiresAt <= (input.now ?? Date.now())) {
    protectionLevel = minLevel(protectionLevel, simulation.status === 'success' ? 'P3' : 'P1')
  }

  const findings = [...simulation.warnings, ...(input.hostFindings || [])]
  const limitations = [...simulation.unknowns, ...(input.hostLimitations || [])]
  const outgoing = simulation.assetChanges.filter((change) => BigInt(change.delta) < 0n)
  const approvals = simulation.authorityChanges.filter((change) => !change.revoked)
  if (outgoing.length) findings.push({
    code: 'ASSETS_LEAVE_WALLET',
    message: `Simulation predicts ${outgoing.length} asset balance decrease${outgoing.length === 1 ? '' : 's'}.`,
    severity: 'warning',
  })
  if (approvals.length) findings.push({
    code: 'AUTHORITY_GRANTED',
    message: `Simulation observed ${approvals.length} new or changed spending authorit${approvals.length === 1 ? 'y' : 'ies'}.`,
    severity: approvals.some((change) => change.unlimited) ? 'danger' : 'warning',
  })
  if (descriptor.authenticated && simulation.status !== 'success') limitations.push({
    code: 'DESCRIPTION_WITHOUT_COMPLETE_SIMULATION',
    message: 'The description is authenticated, but execution effects could not be completely simulated.',
    severity: 'warning',
  })
  if (descriptor.resolution && descriptor.resolution !== 'selected' && descriptor.resolution !== 'no-artifact') limitations.push({
    code: 'CLEARSIGN_DEFINITION_REFUSED',
    message: `A local ClearSign definition was not applied: ${descriptor.resolution}.`,
    severity: descriptor.resolution === 'revoked' || descriptor.resolution === 'identity-changed'
      || descriptor.resolution === 'identity-mismatch' ? 'danger' : 'warning',
  })

  const headline = protectionLevel === 'P5' ? 'Authenticated description bound to deployed code'
    : protectionLevel === 'P4' ? (descriptor.source === 'native' ? 'KeepKey ClearSign ready' : 'Authenticated ClearSign description')
      : protectionLevel === 'P3' ? 'Simulated on this computer; not authenticated by KeepKey'
        : protectionLevel === 'P2' ? 'Decoded on this computer; not authenticated by KeepKey'
          : protectionLevel === 'P0' ? 'Transaction blocked'
            : 'Unknown transaction — blind review required'

  const claims: ClearSignReport['claims'] = [
    { source: 'transaction-bytes', statement: `Report is bound to transaction fingerprint ${simulation.transactionFingerprint}.` },
  ]
  if (descriptor.authenticated) claims.push({
    source: 'authenticated-definition',
    statement: descriptor.source === 'native'
      ? `KeepKey firmware will independently decode and authenticate the signed bytes${descriptor.label ? ` as ${descriptor.label}` : ''}.`
      : `${descriptor.format || 'ClearSign'} metadata was authenticated${descriptor.label ? ` as ${descriptor.label}` : ''}.`,
  })
  if (simulation.status !== 'unavailable') claims.push({
    source: 'simulation',
    statement: `Execution simulation status: ${simulation.status}; effects are predictions at ${simulation.stateReference.blockOrSlot || 'the provider head'}.`,
  })

  return {
    version: 1,
    generatedAt: input.now ?? Date.now(),
    chain: simulation.chain,
    transactionFingerprint: simulation.transactionFingerprint,
    protectionLevel,
    headline,
    descriptor,
    simulation,
    findings,
    limitations,
    claims,
    ...(input.definitionReview ? { definitionReview: input.definitionReview } : {}),
    ...(input.rating ? { rating: input.rating } : {}),
  }
}

/** Convert the bounded transaction-byte decoder into report evidence. */
export function solanaDecodedReportFindings(decoded: SolanaTxDecodedInfo | undefined): {
  findings: EffectFinding[]
  limitations: EffectFinding[]
} {
  if (!decoded) return { findings: [], limitations: [] }
  const findings: EffectFinding[] = []
  const limitations: EffectFinding[] = []
  const sessionKeys = decoded.fundedKeysGivenToUnknownProgram || []
  if (sessionKeys.length) findings.push({
    code: 'SESSION_KEY_FUNDED_AND_REGISTERED',
    message: `Transaction funds ${sessionKeys.length} key${sessionKeys.length === 1 ? '' : 's'} and embeds the same key in an unknown program instruction; this can establish delegated session authority.`,
    severity: 'danger',
  })
  if (decoded.hasUnknownProgram && (decoded.assetPrograms?.length || 0) > 0) findings.push({
    code: 'UNKNOWN_PROGRAM_WITH_ASSET_PROGRAM_ACCESS',
    message: `An unknown program shares the transaction with ${decoded.assetPrograms!.join(', ')} and may invoke asset-moving programs by CPI.`,
    severity: 'danger',
  })
  if (decoded.altResolutionIncomplete) limitations.push({
    code: 'SOLANA_ALT_RESOLUTION_INCOMPLETE',
    message: 'At least one address lookup table could not be resolved; account identities are incomplete.',
    severity: 'danger',
  })
  if (decoded.hasUnknownProgram) limitations.push({
    code: 'UNKNOWN_SOLANA_PROGRAM',
    message: 'At least one instruction targets a program without reviewed decoding semantics.',
    severity: 'warning',
  })
  if (decoded.instructions.some(instruction => instruction.status === 'known-program-unknown-ix')) limitations.push({
    code: 'UNKNOWN_SOLANA_INSTRUCTION',
    message: 'A known program contains an instruction shape that the host decoder does not understand.',
    severity: 'warning',
  })
  return { findings, limitations }
}
