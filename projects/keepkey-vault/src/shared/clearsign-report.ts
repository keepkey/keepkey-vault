import type { ClearSignDefinitionSource, ClearSignProtectionLevel, SolanaTxDecodedInfo } from './types'
import { PLAIN_TRANSFER_NOT_SIMULATED, type EffectFinding, type EffectReport } from './transaction-effects'

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
    /** No artifact; a reviewed, pinned local decoder read the call (display only). */
    | 'reviewed-decoder'
  /** A third-party (runtime) signer that will be asked for, or supplied, a
   *  description. Never KeepKey: the device says "NOT verified by KeepKey". */
  provider?: ClearSignRuntimeProvider
}

export interface ClearSignRuntimeProvider {
  /** Provider name and its fingerprint as the device shows it (16 hex). */
  alias?: string
  fingerprint?: string
  /** A caller's blob names only the device slot (1-3) its signer sits in. */
  keyId?: number
  /** 'requested': asked after approval, may decline. 'supplied': the app sent it. */
  status: 'requested' | 'supplied'
}

/** The card line naming who describes a call when it is not KeepKey.
 *  Matches the device's own words: "NOT verified by KeepKey". */
export function runtimeProviderLine(provider: ClearSignRuntimeProvider | undefined): string | undefined {
  if (!provider) return undefined
  const who = provider.alias
    ? `'${provider.alias}'${provider.fingerprint ? ` (${provider.fingerprint})` : ''}`
    : provider.keyId && provider.keyId >= 1 && provider.keyId <= 3 ? `the signer in slot ${provider.keyId} of your KeepKey` : undefined
  if (!who) return undefined
  return provider.status === 'requested'
    ? `Description requested from ${who}. NOT verified by KeepKey. If it answers, your KeepKey asks you to trust it for this session.`
    : `Description from ${who}. NOT verified by KeepKey.`
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

/**
 * Whether a report has anything the user must read. A transaction the KeepKey
 * shows in full (P4/P5) with nothing to add is simply clear: the app's own
 * swap screen leaves the report out and lets the device speak.
 *
 * Kept visible: any red line (finding or limitation), a contract rated high or
 * critical, and an independent check that could not run. Not kept: the notes
 * every swap carries (assets leave the wallet, a deposit address has no owner
 * the device can check, a bridge delivers through its own off-chain order, a
 * bounded approval to the route's contract, a prediction this computer could
 * not run: the device shows an authenticated transaction in full either way).
 * A swap the user built here is expected to be clear; the box is for when it
 * is not.
 */
export function clearSignReportNeedsAttention(
  report: Pick<ClearSignReport, 'protectionLevel' | 'findings' | 'limitations' | 'rating'>,
): boolean {
  if (report.protectionLevel !== 'P4' && report.protectionLevel !== 'P5') return true
  if ([...report.findings, ...report.limitations].some((line) => line.severity === 'danger' && line.code !== 'SIMULATION_UNAVAILABLE')) return true
  if (report.limitations.some((line) => line.code === 'NEAR_INTENTS_UNCONFIRMED')) return true
  return report.rating?.riskLevel === 'high' || report.rating?.riskLevel === 'critical'
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
  if (descriptor.authenticated && simulation.status !== 'success'
    && !simulation.unknowns.some((unknown) => unknown.code === PLAIN_TRANSFER_NOT_SIMULATED)) limitations.push({
    code: 'DESCRIPTION_WITHOUT_COMPLETE_SIMULATION',
    message: 'The description is authenticated, but execution effects could not be completely simulated.',
    severity: 'warning',
  })
  if (descriptor.resolution && descriptor.resolution !== 'selected' && descriptor.resolution !== 'no-artifact'
    && descriptor.resolution !== 'reviewed-decoder') limitations.push({
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

/**
 * The in-app swap dialog's own gate. A swap Desktop built from a Pioneer quote
 * is a normal request: being blind on this firmware, or having no simulation,
 * is not news (the Advanced Mode panel covers the device side). Only signals
 * that this swap is not what was quoted put the report in front of the user:
 * a NEAR Intents deposit-address red line or unanswered check, or a contract
 * an auditor rated high or critical.
 */
export function swapReportNeedsAttention(report: Pick<ClearSignReport, 'findings' | 'limitations' | 'rating'>): boolean {
  const near = [...report.findings, ...report.limitations].some((line) =>
    line.code.startsWith('NEAR_INTENTS_') && (line.severity === 'danger' || line.code === 'NEAR_INTENTS_UNCONFIRMED'))
  return near || report.rating?.riskLevel === 'high' || report.rating?.riskLevel === 'critical'
}
