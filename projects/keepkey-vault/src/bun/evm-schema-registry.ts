/**
 * Signed EVM v2 clear-sign schemas, looked up per transaction.
 *
 * A v2 schema describes ONE (chain, contract, selector): the method name and
 * the labelled args, each one 32-byte ABI word. It carries no amounts and no
 * transaction hash, so a single signature covers every future call to that
 * method — the device decodes the values out of the calldata it is about to
 * sign. That is why this can be a static registry at all, unlike the v1
 * per-transaction blobs which must commit to a sighash.
 *
 * Attaching a schema does not weaken anything: firmware still verifies the
 * signature against a trusted ClearSign key, still requires the declared arg
 * widths to account for the calldata exactly, and for a payable call still
 * shows the native amount screen. A wrong or unsigned schema is refused, not
 * silently trusted.
 */
import registry from './evm-schemas-local.json'
import { DEFAULT_CLEARSIGN_SERVICE_URL } from './solana-certified-registry'
import { deploymentMismatch, verifyPublishedReview } from './clearsign-review'
import { snapshotEvmIdentities } from './clearsign-live-auditor'
import { getEvmSimulationEndpoint } from './evm-simulation-config'
import type { ClearSignDefinitionReview } from '../shared/clearsign-report'
import {
  buildEvmDecoderBody,
  CERTIFIED_METADATA_KEY_ID,
  ERC20_APPROVE,
  EVM_ARG_ADDRESS_PINNED,
  findCertifiedEvmSchemaSpec,
  findReviewedUniversalRouter,
  isCertifiedEvmMetadata,
  reviewedSwapTokens,
  UR_METHOD,
  type EvmSchemaSpec,
  buildEvmSchemaBody,
} from './evm-certified-schema'
import { buildTokenSchema, tokenCallShape } from './evm-token-schema'
import { findPromotedEvmArtifact } from './clearsign-artifact-resolver'
import { runtimeEvmSighash } from './uniswap-runtime-envelope'

export { isCertifiedEvmMetadata }

export interface SignedEvmSchema {
  method: string
  keyId: number
  /** 0x-prefixed hex — the format hdwallet's ethSignTx expects. */
  signedPayload: string
  /** 4 + 32*num_args; firmware requires the calldata to match exactly. */
  expectedCalldataLength?: number
  source?: 'local-test' | 'certified-service' | 'promoted-local'
  /** Present only for a locally reviewed, identity-bound promotion. */
  bundleHash?: string
  /** Verified definition approvals, when the service published this definition. */
  definitionReview?: ClearSignDefinitionReview
}

const SCHEMAS: Record<string, SignedEvmSchema> = (registry as any).schemas ?? {}

/**
 * Find a schema for this call, or undefined. Returns undefined rather than
 * throwing on any doubt — a missing schema means the existing (blind-sign)
 * behaviour, never a blocked transaction.
 */
export function findEvmSchema(
  chainId: number | undefined,
  to: string | undefined,
  data: string | undefined,
): SignedEvmSchema | undefined {
  if (!chainId || !to || !data) return undefined
  const calldata = data.startsWith('0x') ? data.slice(2) : data
  if (calldata.length < 8) return undefined
  const selector = '0x' + calldata.slice(0, 8).toLowerCase()
  const schema = SCHEMAS[`${chainId}:${to.toLowerCase()}:${selector}`]
  if (!schema) return undefined
  // The device enforces this too, but checking here keeps a stale registry
  // entry from producing a confusing on-device refusal mid-signing.
  if (calldata.length / 2 !== schema.expectedCalldataLength) return undefined
  return schema
}

/**
 * The spender of a standard 68-byte ERC-20 approve whose spender word is a
 * clean address (high 12 bytes zero), else undefined. It is the only argument
 * the schema service ever sees: it picks the Permit2-pinned or generic entry.
 */
export function approveSpender(data: string | undefined): string | undefined {
  const calldata = String(data || '').replace(/^0x/i, '').toLowerCase()
  if (calldata.length !== 136 || `0x${calldata.slice(0, 8)}` !== ERC20_APPROVE) return undefined
  const word = calldata.slice(8, 72)
  return /^0{24}[0-9a-f]{40}$/.test(word) ? `0x${word.slice(24)}` : undefined
}

/** The worker's catalog id for a spec (clearsign-worker evmEntryId). */
export function evmCatalogEntryId(spec: Pick<EvmSchemaSpec, 'chainId' | 'contract' | 'selector' | 'args'>): string {
  const pinned = spec.args.some((arg) => arg.format === EVM_ARG_ADDRESS_PINNED)
  return `eip155:${spec.chainId}:${spec.contract}:${spec.selector}${pinned ? ':permit2' : ''}`.toLowerCase()
}

/** Fetch a KeepKey-certified v3 envelope from the isolated signer service. */
/** Measures the live deployment for a reviewed contract (injectable for tests). */
export type MeasureDeployment = (chainId: number, contract: string) => Promise<unknown>
export const measureLiveDeployment: MeasureDeployment = async (chainId, contract) =>
  (await snapshotEvmIdentities(contract.toLowerCase(), getEvmSimulationEndpoint(chainId))).identities

export async function findCertifiedEvmSchema(
  chainId: number | undefined,
  to: string | undefined,
  data: string | undefined,
  measure: MeasureDeployment = measureLiveDeployment,
): Promise<SignedEvmSchema | undefined> {
  try {
    return await fetchCertifiedEvmSchema(chainId, to, data, measure)
  } catch (error: any) {
    if (!(error instanceof ReviewLookupError)) throw error
    // A published review that fails verification is never shown or used; the
    // call keeps the blind path it had before review lookups existed.
    console.warn(`[clearsign] published review rejected: ${error.message}`)
    return undefined
  }
}

class ReviewLookupError extends Error {}

async function fetchCertifiedEvmSchema(
  chainId: number | undefined,
  to: string | undefined,
  data: string | undefined,
  measure: MeasureDeployment,
): Promise<SignedEvmSchema | undefined> {
  let spec = findCertifiedEvmSchemaSpec(chainId, to, data)
  const calldata = String(data || '').replace(/^0x/i, '')
  const selector = `0x${calldata.slice(0, 8).toLowerCase()}`
  const length = calldata.length / 2
  const tokenCandidate = /^[0-9a-f]+$/i.test(calldata) && tokenCallShape(Number(chainId), String(to || ''), selector, length)
  // Anything else is a lookup for a published, human-reviewed definition. It
  // is best-effort: a slow or unavailable service must leave the call on its
  // existing blind path, never block signing.
  const reviewLookup = !spec && !tokenCandidate
  const fail = (message: string): never => { throw reviewLookup ? new ReviewLookupError(message) : new Error(message) }
  if (reviewLookup && (!/^[0-9a-f]+$/i.test(calldata) || length < 4 || !/^0x[0-9a-f]{40}$/i.test(String(to || '')))) return undefined
  const base = String(process.env.CLEARSIGN_SERVICE_URL || DEFAULT_CLEARSIGN_SERVICE_URL)
    .trim()
    .replace(/\/+$/, '')

  // Only an approve's spender leaves the host (it selects the entry).
  const spender = approveSpender(data)
  let response: Response
  try {
    response = await fetch(`${base}/v1/evm/schema`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The service only needs the reviewed call shape. Do not send recipients,
      // order IDs, amounts, or any other calldata arguments off the host.
      body: JSON.stringify({
        chainId,
        contract: to,
        selector,
        calldataLength: length,
        ...(spender ? { spender } : {}),
      }),
      signal: AbortSignal.timeout(reviewLookup ? 3_000 : 10_000),
    })
  } catch (error: any) {
    if (reviewLookup) return undefined
    throw new Error(`ClearSign verification service is unavailable: ${error?.message || 'connection failed'}`)
  }
  let result: any
  try {
    result = await response.json()
  } catch {
    if (reviewLookup) return undefined
    throw new Error(`ClearSign verification service returned HTTP ${response.status} without valid JSON`)
  }
  if (!response.ok && reviewLookup) return undefined
  if (!response.ok) {
    if (response.status === 422) {
      if (!spec && result?.code !== 'TOKEN_IDENTITY_UNVERIFIED') return undefined
      throw new Error(`ClearSign certified description unavailable for ${spec?.method || 'token call'}: ${result?.error || 'the service catalog must be updated and its signed artifact provisioned before signing'}`)
    }
    throw new Error(`ClearSign verification service returned HTTP ${response.status}: ${result?.error || 'request failed'}`)
  }

  let review: ClearSignDefinitionReview | undefined
  if (reviewLookup) {
    try {
      const verified = verifyPublishedReview(result?.review,
        { chainId: Number(chainId), contract: String(to), selector, calldataLength: length })
      spec = verified.spec
      review = verified.review
      // The device renders the envelope, not this JSON: the reviewed schema must
      // be byte-identical to the signed body or nothing from the review is shown.
      const envelope = Buffer.from(String(result.signedPayload || '').replace(/^0x/i, ''), 'hex')
      if (!envelope.subarray(140, -65).equals(buildEvmSchemaBody(spec) as Uint8Array)) {
        throw new Error('ClearSign review schema differs from the signed envelope')
      }
      // The audit covers one deployment. An upgrade (new implementation) or a
      // redeploy changes the measured code, and the call goes back to blind
      // signing until it is re-audited. Unmeasurable counts as changed.
      const changed = deploymentMismatch(review.auditedIdentities, await measure(Number(chainId), String(to)))
      if (changed) throw new Error(`review no longer applies: ${changed}; re-audit required`)
    } catch (error: any) {
      throw new ReviewLookupError(error?.message || 'invalid published review')
    }
  } else if (!spec) {
    const token = result?.tokenIdentity
    if (!token || token.chainId !== chainId || String(token.contract).toLowerCase() !== String(to).toLowerCase()
      || token.source !== 'pioneer-discovery' || !/^[0-9a-f]{64}$/.test(token.sourceSha256)) {
      throw new Error('ClearSign service returned an invalid token identity')
    }
    spec = buildTokenSchema(Number(chainId), String(to), selector, length, token)
    // Bind displayed symbol/scale to the actual signed schema, never just JSON.
    const envelope = Buffer.from(String(result.signedPayload || '').replace(/^0x/i, ''), 'hex')
    if (!envelope.subarray(140, -65).equals(buildEvmSchemaBody(spec))) {
      throw new Error('ClearSign token identity differs from the signed schema')
    }
  }

  const candidate = {
    signedPayload: result?.signedPayload,
    keyId: result?.keyId,
  }
  if (!isCertifiedEvmMetadata(candidate)) {
    fail('ClearSign verification service returned a non-certified payload')
  }
  const certificateEnvelope = Buffer.from(String(result.signedPayload).replace(/^0x/i, ''), 'hex')
  if (certificateEnvelope.readUInt32BE(3) !== chainId) {
    fail(`ClearSign certificate is not authorized for chain ${chainId}; a chain-scoped root certificate is required`)
  }
  if (
    result?.classification !== 'VERIFIED' ||
    result?.chainId !== spec.chainId ||
    String(result?.contract || '').toLowerCase() !== spec.contract.toLowerCase() ||
    String(result?.selector || '').toLowerCase() !== spec.selector.toLowerCase() ||
    result?.method !== spec.method ||
    result?.expectedCalldataLength !== spec.expectedCalldataLength ||
    result?.keyId !== CERTIFIED_METADATA_KEY_ID ||
    // Older workers omit `entry`; when present it must be the entry we expect
    // (e.g. the Permit2-pinned approve, not the generic one).
    (result?.entry !== undefined && String(result.entry).toLowerCase() !== evmCatalogEntryId(spec))
  ) {
    fail('ClearSign verification service response does not match the requested schema')
  }
  return {
    method: spec.method,
    keyId: CERTIFIED_METADATA_KEY_ID,
    signedPayload: result.signedPayload,
    expectedCalldataLength: spec.expectedCalldataLength,
    source: 'certified-service',
    ...(review ? { definitionReview: review } : {}),
  }
}

const serviceBase = () => String(process.env.CLEARSIGN_SERVICE_URL || DEFAULT_CLEARSIGN_SERVICE_URL).trim().replace(/\/+$/, '')

/**
 * Fetch a certified 0x07 Uniswap swap entry for (router, selector) naming
 * exactly `tokens`. Undefined (no request) unless the router and every token
 * are reviewed locally; undefined on 422. Only the router, selector and token
 * addresses leave the host: no amounts, recipients or calldata. The returned
 * body must be byte-identical to the one built here from the same reviewed
 * table, so the service cannot substitute a token identity.
 */
export async function findCertifiedUniswapSwap(
  chainId: number,
  router: string,
  selector: string,
  tokens: string[],
): Promise<Pick<SignedEvmSchema, 'method' | 'keyId' | 'signedPayload'> | undefined> {
  const reviewed = findReviewedUniversalRouter(chainId, router)
  const identities = reviewedSwapTokens(chainId, tokens)
  if (!reviewed || !identities) return undefined
  const expectedBody = buildEvmDecoderBody(chainId, reviewed.address, selector, identities)
  let response: Response
  try {
    response = await fetch(`${serviceBase()}/v1/evm/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId, contract: reviewed.address, selector, tokens: identities.map((t) => t.address) }),
      signal: AbortSignal.timeout(3_000),
    })
  } catch (error: any) {
    throw new Error(`ClearSign verification service is unavailable: ${error?.message || 'connection failed'}`)
  }
  let result: any
  try {
    result = await response.json()
  } catch {
    throw new Error(`ClearSign verification service returned HTTP ${response.status} without valid JSON`)
  }
  if (!response.ok) {
    if (response.status === 422) return undefined
    throw new Error(`ClearSign verification service returned HTTP ${response.status}: ${result?.error || 'request failed'}`)
  }
  if (!isCertifiedEvmMetadata({ signedPayload: result?.signedPayload, keyId: result?.keyId })) {
    throw new Error('ClearSign verification service returned a non-certified payload')
  }
  // 0x03 | certificate(139) | body | r,s,v(65)
  const payload = Buffer.from(String(result.signedPayload).replace(/^0x/i, ''), 'hex')
  if (
    result?.classification !== 'VERIFIED' ||
    result?.chainId !== chainId ||
    String(result?.entry || '').toLowerCase() !== `eip155:${chainId}:${reviewed.address}:uniswap-ur` ||
    payload.length !== 1 + 139 + expectedBody.length + 65 ||
    !payload.subarray(140, 140 + expectedBody.length).equals(expectedBody)
  ) {
    throw new Error('ClearSign verification service response does not match the requested swap entry')
  }
  return {
    method: UR_METHOD,
    keyId: CERTIFIED_METADATA_KEY_ID,
    signedPayload: result.signedPayload,
  }
}

export async function resolveEvmSchema(
  chainId: number | undefined,
  to: string | undefined,
  data: string | undefined,
  certifiedMetadataSupported = true,
): Promise<SignedEvmSchema | undefined> {
  // Older firmware may not handle EthereumTxMetadata at all. In particular,
  // never substitute the local CI-key schema when the certified path is off.
  // The caller's ordinary Advanced Mode policy gate still applies.
  if (!certifiedMetadataSupported) return undefined
  const promoted = findPromotedEvmArtifact(chainId, to, data)
  if (promoted) return { ...promoted, keyId: CERTIFIED_METADATA_KEY_ID, source: 'promoted-local' }
  return (await findCertifiedEvmSchema(chainId, to, data))
    ?? findEvmSchema(chainId, to, data)
}

/** Resolve a reviewed description bound to this complete transaction. Used
 * for dynamic router programs whose safety-defining fields exceed the device's
 * initial calldata chunk. */
export async function resolveCertifiedEvmTransaction(tx: any): Promise<SignedEvmSchema | undefined> {
  if (Number(tx?.chainId) !== 42161
    || String(tx?.to || '').toLowerCase() !== '0x2d01411773c8c24805306e89a41f7855c3c4fe65'
    || !String(tx?.data || '').toLowerCase().startsWith('0x3593564c')) return undefined
  const base = String(process.env.CLEARSIGN_SERVICE_URL || DEFAULT_CLEARSIGN_SERVICE_URL).trim().replace(/\/+$/, '')
  const response = await fetch(`${base}/v1/evm/transaction`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tx), signal: AbortSignal.timeout(10_000),
  })
  const result: any = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`ClearSign transaction description unavailable: ${result?.error || `HTTP ${response.status}`}`)
  if (!isCertifiedEvmMetadata({ signedPayload: result?.signedPayload, keyId: result?.keyId })
    || result?.classification !== 'VERIFIED' || result?.chainId !== 42161
    || String(result?.contract).toLowerCase() !== String(tx.to).toLowerCase()
    || String(result?.selector).toLowerCase() !== '0x3593564c'
    || String(result?.txHash).toLowerCase() !== `0x${runtimeEvmSighash(tx).toString('hex')}`) {
    throw new Error('ClearSign transaction response does not match the transaction being approved')
  }
  return { method: String(result.method), keyId: CERTIFIED_METADATA_KEY_ID,
    signedPayload: String(result.signedPayload), source: 'certified-service' }
}
