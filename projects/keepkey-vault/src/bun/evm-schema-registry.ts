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
} from './evm-certified-schema'

export { isCertifiedEvmMetadata }

export interface SignedEvmSchema {
  method: string
  keyId: number
  /** 0x-prefixed hex — the format hdwallet's ethSignTx expects. */
  signedPayload: string
  /** 4 + 32*num_args; firmware requires the calldata to match exactly. */
  expectedCalldataLength: number
  source?: 'local-test' | 'certified-service'
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
export async function findCertifiedEvmSchema(
  chainId: number | undefined,
  to: string | undefined,
  data: string | undefined,
): Promise<SignedEvmSchema | undefined> {
  const spec = findCertifiedEvmSchemaSpec(chainId, to, data)
  if (!spec) return undefined
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
        selector: spec.selector,
        calldataLength: spec.expectedCalldataLength,
        ...(spender ? { spender } : {}),
      }),
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

  const candidate = {
    signedPayload: result?.signedPayload,
    keyId: result?.keyId,
  }
  if (!isCertifiedEvmMetadata(candidate)) {
    throw new Error('ClearSign verification service returned a non-certified payload')
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
    throw new Error('ClearSign verification service response does not match the requested schema')
  }
  return {
    method: spec.method,
    keyId: CERTIFIED_METADATA_KEY_ID,
    signedPayload: result.signedPayload,
    expectedCalldataLength: spec.expectedCalldataLength,
    source: 'certified-service',
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
  return (await findCertifiedEvmSchema(chainId, to, data)) ?? findEvmSchema(chainId, to, data)
}
