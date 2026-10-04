/**
 * Privacy-safe ClearSign demand fingerprints.
 *
 * These records answer "what did users need us to understand?" without
 * retaining calldata arguments, amounts, account addresses, blockhashes, raw
 * transactions, or signatures. They are telemetry for the local audit queue,
 * not evidence that a description is correct.
 */
import { createHash } from 'node:crypto'
import bs58 from 'bs58'

import type {
  ClearSignDefinitionSource,
  ClearSignObservationDraft,
  ClearSignObservation,
  ClearSignCoverageSummary,
  ClearSignCoverageSlice,
  ClearSignEventSource,
  ClearSignSimulationStatus,
  ClearSignDefinitionResolution,
  ClearSignExposureClass,
  ClearSignProtectionLevel,
} from '../shared/types'
import type { EffectReport } from '../shared/transaction-effects'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from './solana-tx'

function digestShape(shape: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex')
}

/** Audit and promotion operate on one reusable instruction; coverage remains per signing request. */
export function expandClearSignAuditDrafts(draft: ClearSignObservationDraft): ClearSignObservationDraft[] {
  if (draft.chain !== 'Solana' || !Array.isArray(draft.shape.components)) return [draft]
  return draft.shape.components
    .filter(component => component && typeof component === 'object')
    .map(component => {
      const shape = { components: [component as Record<string, unknown>] }
      return { ...draft, shape, shapeKey: `solana-ix:${digestShape(shape)}` }
    })
}

const EXPOSURE_PRIORITY: Record<ClearSignExposureClass, number> = {
  'not-evaluated': 5,
  'unknown-effects': 4,
  'unlimited-authority': 3,
  'delegated-authority': 2,
  'bounded-outflow': 1,
  'none-observed': 0,
}
export function clearSignExposurePriority(value: ClearSignExposureClass): number { return EXPOSURE_PRIORITY[value] }

/** Reduce simulation effects to a privacy-safe audit-priority class. */
export function classifyEffectExposure(report: EffectReport | undefined): ClearSignExposureClass {
  if (!report) return 'not-evaluated'
  if (report.status !== 'success') return 'unknown-effects'
  if (report.authorityChanges.some(change => !change.revoked && change.unlimited)) return 'unlimited-authority'
  if (report.authorityChanges.some(change => !change.revoked)) return 'delegated-authority'
  if (report.assetChanges.some(change => BigInt(change.delta) < 0n)) return 'bounded-outflow'
  return 'none-observed'
}

/** Request-weighted coverage summary. P4/P5 only count as authenticated. */
export function summarizeClearSignObservations(observations: ClearSignObservation[], now = Date.now()): ClearSignCoverageSummary {
  const byLevel: ClearSignCoverageSummary['byLevel'] = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 }
  const byOutcome: ClearSignCoverageSummary['byOutcome'] = {
    pending: 0, signed: 0, rejected: 0, 'timed-out': 0, 'policy-blocked': 0, failed: 0,
  }
  const bySimulation: ClearSignCoverageSummary['bySimulation'] = {
    'not-requested': 0, success: 0, revert: 0, incomplete: 0, unavailable: 0,
  }
  const definitionStatuses: ClearSignDefinitionResolution[] = [
    'not-checked', 'selected', 'invalid-request', 'no-artifact', 'shape-mismatch', 'revoked', 'expired',
    'identity-unavailable', 'identity-stale', 'identity-changed', 'identity-mismatch', 'unsupported-alt',
  ]
  const byDefinitionResolution = Object.fromEntries(definitionStatuses.map(status => [status, 0])) as ClearSignCoverageSummary['byDefinitionResolution']
  const exposureClasses: ClearSignExposureClass[] = ['not-evaluated', 'none-observed', 'bounded-outflow', 'delegated-authority', 'unlimited-authority', 'unknown-effects']
  const byExposure = Object.fromEntries(exposureClasses.map(status => [status, 0])) as ClearSignCoverageSummary['byExposure']
  const unknown = new Map<string, ClearSignCoverageSummary['topUnknown'][number]>()
  const components = new Map<string, ClearSignCoverageSummary['topComponents'][number]>()
  const emptySlice = (): ClearSignCoverageSlice => ({ totalRequests: 0, authenticatedRequests: 0, authenticatedPercent: 0 })
  const byChain: ClearSignCoverageSummary['byChain'] = { Ethereum: emptySlice(), Solana: emptySlice() }
  const sources: ClearSignEventSource[] = ['studio', 'vault-rpc', 'rest-api', 'walletconnect', 'vault-swap']
  const bySource = Object.fromEntries(sources.map(source => [source, emptySlice()])) as ClearSignCoverageSummary['bySource']
  const last24Hours = emptySlice()
  const last7Days = emptySlice()
  const componentCoverage = {
    totalAppearances: 0, authenticatedAppearances: 0, authenticatedPercent: 0,
    fullyAuthenticatedRequests: 0, partiallyAuthenticatedRequests: 0, unauthenticatedRequests: 0,
  }
  const add = (slice: ClearSignCoverageSlice, authenticated: boolean) => {
    slice.totalRequests++
    if (authenticated) slice.authenticatedRequests++
  }
  for (const observation of observations) {
    byLevel[observation.protectionLevel]++
    byOutcome[observation.outcome]++
    bySimulation[observation.simulationStatus || 'not-requested']++
    byDefinitionResolution[observation.definitionResolution || 'not-checked']++
    const exposureClass = observation.exposureClass || 'not-evaluated'
    byExposure[exposureClass]++
    const authenticated = observation.protectionLevel === 'P4' || observation.protectionLevel === 'P5'
    const derivedComponentCount = observation.chain === 'Solana' && Array.isArray(observation.shape.components)
      ? Math.max(1, observation.shape.components.length) : 1
    const componentCount = Math.max(1, observation.componentCount || derivedComponentCount)
    // Old P4/P5 rows predate component accounting. Conservatively credit one
    // authenticated descriptor rather than every instruction in the request.
    const authenticatedComponentCount = Math.min(componentCount, Math.max(0,
      observation.authenticatedComponentCount ?? (authenticated ? 1 : 0)))
    componentCoverage.totalAppearances += componentCount
    componentCoverage.authenticatedAppearances += authenticatedComponentCount
    if (authenticatedComponentCount === 0) componentCoverage.unauthenticatedRequests++
    else if (authenticatedComponentCount >= componentCount) componentCoverage.fullyAuthenticatedRequests++
    else componentCoverage.partiallyAuthenticatedRequests++
    add(byChain[observation.chain], authenticated)
    add(bySource[observation.source], authenticated)
    const age = Math.max(0, now - observation.createdAt)
    if (age <= 24 * 60 * 60 * 1000) add(last24Hours, authenticated)
    if (age <= 7 * 24 * 60 * 60 * 1000) add(last7Days, authenticated)
    const requestComponents = observation.chain === 'Solana' && Array.isArray(observation.shape.components)
      ? observation.shape.components.filter(value => value && typeof value === 'object') as Record<string, unknown>[]
      : [observation.shape]
    for (const component of requestComponents) {
      const componentKey = observation.chain === 'Solana'
        ? `solana-ix:${digestShape({ components: [component] })}`
        : observation.shapeKey
      const current = components.get(componentKey)
      if (current) {
        current.count++
        if (EXPOSURE_PRIORITY[exposureClass] > EXPOSURE_PRIORITY[current.maxExposureClass]) current.maxExposureClass = exposureClass
      } else components.set(componentKey, {
        componentKey, chain: observation.chain, count: 1, component, maxExposureClass: exposureClass,
      })
    }
    if (authenticated) continue
    const current = unknown.get(observation.shapeKey)
    if (current) {
      current.count++
      if (EXPOSURE_PRIORITY[exposureClass] > EXPOSURE_PRIORITY[current.maxExposureClass]) {
        current.maxExposureClass = exposureClass
      }
    }
    else unknown.set(observation.shapeKey, {
      shapeKey: observation.shapeKey,
      chain: observation.chain,
      count: 1,
      shape: observation.shape,
      maxExposureClass: exposureClass,
    })
  }
  const authenticatedRequests = byLevel.P4 + byLevel.P5
  componentCoverage.authenticatedPercent = componentCoverage.totalAppearances
    ? Math.round(componentCoverage.authenticatedAppearances * 10_000 / componentCoverage.totalAppearances) / 100 : 0
  const finish = (slice: ClearSignCoverageSlice) => {
    slice.authenticatedPercent = slice.totalRequests
      ? Math.round(slice.authenticatedRequests * 10_000 / slice.totalRequests) / 100
      : 0
  }
  Object.values(byChain).forEach(finish)
  Object.values(bySource).forEach(finish)
  finish(last24Hours)
  finish(last7Days)
  const attemptedRequests = observations.length - bySimulation['not-requested']
  const simulation = {
    attemptedRequests,
    successfulRequests: bySimulation.success,
    successPercent: attemptedRequests ? Math.round(bySimulation.success * 10_000 / attemptedRequests) / 100 : 0,
  }
  const checkedRequests = observations.length - byDefinitionResolution['not-checked']
  const definitions = {
    checkedRequests,
    selectedRequests: byDefinitionResolution.selected,
    noArtifactRequests: byDefinitionResolution['no-artifact'],
    refusedRequests: checkedRequests - byDefinitionResolution.selected - byDefinitionResolution['no-artifact'],
  }
  return {
    totalRequests: observations.length,
    authenticatedRequests,
    authenticatedPercent: observations.length ? Math.round(authenticatedRequests * 10_000 / observations.length) / 100 : 0,
    componentCoverage,
    byLevel,
    byOutcome,
    bySimulation,
    simulation,
    byDefinitionResolution,
    byExposure,
    definitions,
    auditQueue: { pending: 0, auditing: 0, evidenceReady: 0, covered: 0, failed: 0, identityChanged: 0, historicalIdentityChanges: 0 },
    byChain,
    bySource,
    rolling: { last24Hours, last7Days },
    topUnknown: [...unknown.values()].sort((a, b) =>
      EXPOSURE_PRIORITY[b.maxExposureClass] - EXPOSURE_PRIORITY[a.maxExposureClass]
      || b.count - a.count || a.shapeKey.localeCompare(b.shapeKey)).slice(0, 20),
    topComponents: [...components.values()].sort((a, b) =>
      b.count - a.count || EXPOSURE_PRIORITY[b.maxExposureClass] - EXPOSURE_PRIORITY[a.maxExposureClass]
      || a.componentKey.localeCompare(b.componentKey)).slice(0, 50),
  }
}

function levelFor(source: ClearSignDefinitionSource, hostDecoded: boolean, simulated: boolean): ClearSignProtectionLevel {
  if (simulated) return 'P3'
  // Presence is not authentication. Certified/ERC-7730 metadata is only a
  // host-visible candidate until the device accepts it for these exact bytes;
  // authenticateClearSignObservation is the sole P4 transition.
  if (hostDecoded || source !== 'none') return 'P2'
  return 'P1'
}

/** Device acceptance advances only authenticated publishers; P5 also requires current code identity. */
export function authenticatedClearSignLevel(source: ClearSignDefinitionSource, codeIdentityBound: boolean): ClearSignProtectionLevel {
  if (source !== 'certified' && source !== 'erc7730') return 'P2'
  return codeIdentityBound ? 'P5' : 'P4'
}

export interface EvmObservationInput {
  chainId: number
  to?: string
  data?: string
  source?: ClearSignDefinitionSource
  hostDecoded?: boolean
  simulated?: boolean
  simulationStatus?: Exclude<ClearSignSimulationStatus, 'not-requested'>
  definitionResolution?: ClearSignDefinitionResolution
  exposureClass?: ClearSignExposureClass
}

export interface EvmTypedDataObservationInput {
  typedData: unknown
  chainId?: number
  source?: ClearSignDefinitionSource
  hostDecoded?: boolean
}

/** Fingerprint an EIP-712 schema and public binding context without retaining domain names or message values. */
export function observeEvmTypedData(input: EvmTypedDataObservationInput): ClearSignObservationDraft {
  const typed: any = input.typedData && typeof input.typedData === 'object' ? input.typedData : {}
  const domain = typed.domain && typeof typed.domain === 'object' ? typed.domain : {}
  const rawTypes = typed.types && typeof typed.types === 'object' ? typed.types : {}
  const primaryType = typeof typed.primaryType === 'string' && typed.primaryType ? typed.primaryType : 'unknown'
  const seen = new Set<string>()
  const types: Record<string, Array<{ name: string; type: string }>> = {}
  const visit = (name: string, depth: number) => {
    if (depth > 8 || seen.size >= 32 || seen.has(name) || name === 'EIP712Domain') return
    seen.add(name)
    const fields = Array.isArray(rawTypes[name]) ? rawTypes[name].slice(0, 64) : []
    types[name] = fields.map((field: any) => ({
      name: typeof field?.name === 'string' ? field.name.slice(0, 128) : '',
      type: typeof field?.type === 'string' ? field.type.slice(0, 128) : 'unknown',
    }))
    for (const field of types[name]) {
      const child = field.type.replace(/\[[^\]]*\]/g, '')
      if (rawTypes[child]) visit(child, depth + 1)
    }
  }
  visit(primaryType, 0)
  const verifyingContract = /^0x[0-9a-fA-F]{40}$/.test(String(domain.verifyingContract || ''))
    ? String(domain.verifyingContract).toLowerCase() : 'none'
  const domainChainId = Number(domain.chainId ?? input.chainId ?? 1)
  const shape = {
    chainId: Number.isSafeInteger(domainChainId) && domainChainId > 0 ? domainChainId : -1,
    verifyingContract,
    primaryType,
    types,
  }
  const source = input.source || 'none'
  return {
    chain: 'Ethereum', requestKind: 'evm-typed-data', shapeKey: `eip712:${digestShape(shape)}`, shape,
    protectionLevel: levelFor(source, input.hostDecoded !== false, false), definitionSource: source,
    simulationStatus: 'not-requested', definitionResolution: source === 'none' ? 'not-checked' : 'selected',
    exposureClass: 'not-evaluated',
  }
}

/** Fingerprint an EVM call by public contract shape, never by its arguments. */
export function observeEvmCall(input: EvmObservationInput): ClearSignObservationDraft {
  const clean = String(input.data || '0x').replace(/^0x/i, '').toLowerCase()
  const valid = /^[0-9a-f]*$/.test(clean) && clean.length % 2 === 0
  const selector = valid && clean.length >= 8 ? `0x${clean.slice(0, 8)}` : 'none'
  const contract = /^0x[0-9a-fA-F]{40}$/.test(String(input.to || ''))
    ? String(input.to).toLowerCase()
    : 'contract-creation'
  const shape = {
    chainId: input.chainId,
    contract,
    selector,
    calldataLength: valid ? clean.length / 2 : -1,
  }
  const source = input.source || 'none'
  return {
    chain: 'Ethereum',
    requestKind: 'evm-call',
    shapeKey: `evm:${digestShape(shape)}`,
    shape,
    protectionLevel: levelFor(source, input.hostDecoded === true, input.simulated === true),
    definitionSource: source,
    simulationStatus: input.simulationStatus || (input.simulated ? 'success' : 'not-requested'),
    definitionResolution: input.definitionResolution || (source === 'none' ? 'not-checked' : 'selected'),
    exposureClass: input.exposureClass || 'not-evaluated',
  }
}

export interface SolanaObservationInput {
  rawTxBase64: string
  source?: ClearSignDefinitionSource
  hostDecoded?: boolean
  simulated?: boolean
  simulationStatus?: Exclude<ClearSignSimulationStatus, 'not-requested'>
  definitionResolution?: ClearSignDefinitionResolution
  exposureClass?: ClearSignExposureClass
}

/**
 * Fingerprint a Solana transaction as a list of instruction shapes. Account
 * addresses are deliberately omitted. `prefix1` is the useful roll-up for
 * compact proprietary instructions; `prefix8` preserves Anchor candidates for
 * audit triage without retaining instruction arguments.
 */
export function observeSolanaTransaction(input: SolanaObservationInput): ClearSignObservationDraft {
  // Uint8Array.from avoids the Bun/Node Buffer generic mismatch under the
  // repository's current TypeScript lib combination.
  const full = Uint8Array.from(Buffer.from(input.rawTxBase64, 'base64'))
  const tx = parseSolanaTx(full)
  const message = parseSolanaMessage(solanaMessageSlice(full, tx))
  const staticCount = message.staticAccounts.length
  const writableSignerEnd = message.header.numRequiredSignatures - message.header.numReadonlySignedAccounts
  const writableUnsignedEnd = staticCount - message.header.numReadonlyUnsignedAccounts
  const loadedWritableCount = message.altEntries.reduce((count, entry) => count + entry.writableIndices.length, 0)
  const accountPrivilege = (index: number) => ({
    index,
    signer: index < message.header.numRequiredSignatures,
    writable: index < staticCount
      ? (index < message.header.numRequiredSignatures ? index < writableSignerEnd : index < writableUnsignedEnd)
      : index < staticCount + loadedWritableCount,
    source: index < staticCount ? 'static' : index < staticCount + loadedWritableCount ? 'alt-writable' : 'alt-readonly',
  })
  const components = message.instructions.map((ix) => {
    const program = message.staticAccounts[ix.programIdIndex]
    const data = Buffer.from(ix.data)
    return {
      program: program ? bs58.encode(program) : `lookup-table-index:${ix.programIdIndex}`,
      prefix1: data.subarray(0, 1).toString('hex'),
      prefix8: data.subarray(0, Math.min(8, data.length)).toString('hex'),
      dataLength: data.length,
      accountCount: ix.accountIndices.length,
      accountPrivileges: ix.accountIndices.map(accountPrivilege),
    }
  })
  const shape = {
    version: message.version,
    hasLookupTables: message.altEntries.length > 0,
    components,
  }
  const source = input.source || 'none'
  return {
    chain: 'Solana',
    requestKind: 'solana-transaction',
    shapeKey: `solana:${digestShape(shape)}`,
    shape,
    protectionLevel: levelFor(source, input.hostDecoded === true, input.simulated === true),
    definitionSource: source,
    simulationStatus: input.simulationStatus || (input.simulated ? 'success' : 'not-requested'),
    definitionResolution: input.definitionResolution || (source === 'none' ? 'not-checked' : 'selected'),
    exposureClass: input.exposureClass || 'not-evaluated',
  }
}

/** Count an unparseable request without retaining or hashing its private bytes. */
export function observeMalformedSolanaTransaction(rawTxBase64: string): ClearSignObservationDraft {
  let wireLength = -1
  try { wireLength = Buffer.from(rawTxBase64, 'base64').length } catch { /* invalid base64 */ }
  const shape = { parseStatus: 'malformed', wireLength }
  return {
    chain: 'Solana',
    requestKind: 'solana-transaction',
    shapeKey: `solana:${digestShape(shape)}`,
    shape,
    protectionLevel: 'P0',
    definitionSource: 'none',
    simulationStatus: 'not-requested',
    definitionResolution: 'invalid-request',
    exposureClass: 'not-evaluated',
  }
}
