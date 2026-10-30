/**
 * ERC-7730 calldata definitions (7.16+) and typed-data definitions (7.17+)
 * from the KeepKey ClearSign service, checked here before one reaches the
 * device.
 *
 * The service signs ERC-7730 v2 programs (C773) into K773 envelopes. Firmware
 * 7.16 verifies the envelope itself; Desktop's checks decide only whether to
 * send one, so a definition the device would refuse (or that describes another
 * call) never replaces the normal review:
 *  - sha256(envelope) is the definition id;
 *  - the program header names this chain, contract and selector;
 *  - the program has no embedded-call formatter: on 7.16 a missing inner
 *    definition fails the whole signature after the outer screens (owner,
 *    2026-10-16: skip embedded calls). When the bytes cannot say, no definition;
 *  - the catalog signature checks out to the root the device trusts, as the
 *    device checks it: Desktop never attaches (or shows as clear-signed) an
 *    envelope it cannot verify itself.
 * A 404 or 422 means no definition; nothing here throws.
 */
import { createHash } from 'node:crypto'
import { DEFAULT_CLEARSIGN_SERVICE_URL } from './solana-certified-registry'
import { firmwareClearSigns } from './calldata-decoder'
import { utils as ethersUtils } from 'ethers'
import { erc7730CalldataSkipReason, supportsErc7730Transport, supportsErc7730TypedData } from '../shared/erc7730-support'
import { deviceErrorMessage } from '../shared/device-error'
import { erc7730EnvelopeSigner } from './erc7730-describe'
import type { Erc7730Catalog } from '../shared/types'

const TAG = '[erc7730]'
/** Envelope hex limit, as the REST schema has always bounded it. */
const ENVELOPE_MAX_HEX = 35_000
const PROGRAM_HEADER_SIZE = 179
const KIND_CALLDATA = 1
const KIND_EIP712 = 2
/** C773 program sections (python-keepkey keepkeylib/erc7730_compiler.py). */
const SECTION_FORMATTERS = 6
const SECTION_RESOURCES = 9
/** 7.16 erc7730_program limits (ERC7730_PROGRAM_MAX_SECTIONS, ERC7730_FORMATTER_MAX_ARGUMENTS). */
const MAX_SECTIONS = 9
const MAX_FORMATTERS = 64
const MAX_FORMATTER_ARGUMENTS = 23
/** Formatter kind "calldata": the embedded-call formatter. */
const FORMATTER_EMBEDDED_CALL = 13

/** Definitions a device refused this session: never sent again, so a retry
 *  (a swap after the AdvancedMode opt-in) does not repeat the refused review. */
const refusedDefinitionIds = new Set<string>()

/** Forget this session's refusals (unit tests start clean). */
export function forgetRefusedErc7730Definitions(): void {
  refusedDefinitionIds.clear()
}

const serviceBase = () => String(process.env.CLEARSIGN_SERVICE_URL || DEFAULT_CLEARSIGN_SERVICE_URL).trim().replace(/\/+$/, '')

export interface Erc7730EnvelopeHeader {
  /** 1 calldata, 2 EIP-712. */
  kind: number
  chainId: bigint
  /** 0x + 40 hex, lowercase. */
  contract: string
  /** 0x + 64 hex: the selector padded with zeros, or the EIP-712 typeHash. */
  selectorOrTypeHash: string
  /** undefined: the program sections could not be read. */
  embeddedCall: boolean | undefined
}

const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

/**
 * Whether a C773 program uses the embedded-call formatter; undefined when its
 * sections cannot be read the way 7.16 reads them (erc7730_program.c): section
 * types 1..9 strictly increasing, exactly the declared count, ending exactly at
 * the program length; at most 64 formatters, each with 1..23 arguments, ending
 * exactly at the formatter section's end.
 */
export function programHasEmbeddedCall(program: Uint8Array): boolean | undefined {
  if (program.length < PROGRAM_HEADER_SIZE) return undefined
  let formatters: Uint8Array | undefined
  let resources: Uint8Array | undefined
  let at = PROGRAM_HEADER_SIZE
  let last = 0
  for (let i = 0; i < program[PROGRAM_HEADER_SIZE - 1]; i++) {
    if (at + 5 > program.length) return undefined
    const kind = program[at]
    const length = be32(program, at + 1)
    if (kind === 0 || kind > MAX_SECTIONS || kind <= last || at + 5 + length > program.length) return undefined
    const value = program.subarray(at + 5, at + 5 + length)
    if (kind === SECTION_FORMATTERS) formatters = value
    if (kind === SECTION_RESOURCES) resources = value
    last = kind
    at += 5 + length
  }
  if (at !== program.length) return undefined
  if (!formatters || formatters.length < 2) return undefined
  const count = (formatters[0] << 8) | formatters[1]
  if (count > MAX_FORMATTERS) return undefined
  let embedded = false
  let p = 2
  for (let i = 0; i < count; i++) {
    if (p + 3 > formatters.length) return undefined
    const args = formatters[p + 2]
    if (args === 0 || args > MAX_FORMATTER_ARGUMENTS) return undefined
    if (formatters[p] === FORMATTER_EMBEDDED_CALL) embedded = true
    p += 3 + 4 * args
  }
  if (p !== formatters.length) return undefined
  // The resource summary's own flag for the same thing.
  if (resources && resources.length >= 20 && resources[19] !== 0) embedded = true
  return embedded
}

/** The K773 envelope's program header, or undefined when it is not one. */
export function readErc7730Envelope(envelope: Uint8Array): Erc7730EnvelopeHeader | undefined {
  // 'K773' 01 01 | program_length be32 | program ('C773' 01 02 ...) | proof | certificate | signature
  if (envelope.length < 10 + PROGRAM_HEADER_SIZE || hex(envelope.subarray(0, 6)) !== '4b3737330101') return undefined
  const programLength = be32(envelope, 6)
  if (programLength < PROGRAM_HEADER_SIZE || 10 + programLength > envelope.length) return undefined
  const program = envelope.subarray(10, 10 + programLength)
  if (hex(program.subarray(0, 6)) !== '433737330102') return undefined
  return {
    kind: program[7],
    chainId: Buffer.from(program.subarray(10, 18)).readBigUInt64BE(0),
    contract: `0x${hex(program.subarray(18, 38))}`,
    selectorOrTypeHash: `0x${hex(program.subarray(38, 70))}`,
    embeddedCall: programHasEmbeddedCall(program),
  }
}

const HEX_BYTES = /^(?:[0-9a-f]{2})+$/

/**
 * A definition for exactly this call, or the reason it is not one. `claimed`
 * holds the service's own JSON fields, which must agree with the header.
 */
export function checkErc7730CalldataDefinition(
  definition: { definitionId?: unknown; envelope?: unknown; kind?: unknown; chainId?: unknown; contractAddress?: unknown; selectorOrTypeHash?: unknown },
  call: { chainId: number; to: string; data: string },
): { entry: Erc7730Catalog['definitions'][number] } | { reason: string } {
  const envelopeHex = typeof definition.envelope === 'string' ? definition.envelope.replace(/^0x/i, '').toLowerCase() : ''
  const id = typeof definition.definitionId === 'string' ? definition.definitionId.replace(/^0x/i, '').toLowerCase() : ''
  if (!HEX_BYTES.test(envelopeHex) || envelopeHex.length > ENVELOPE_MAX_HEX) return { reason: 'envelope is not bounded hex' }
  if (!/^[0-9a-f]{64}$/.test(id)) return { reason: 'definition id is not 32 bytes' }
  const envelope = Uint8Array.from(Buffer.from(envelopeHex, 'hex'))
  if (createHash('sha256').update(envelope).digest('hex') !== id) return { reason: 'definition id is not sha256(envelope)' }
  const header = readErc7730Envelope(envelope)
  if (!header) return { reason: 'not a K773 envelope' }
  const to = call.to.toLowerCase()
  const selector = call.data.slice(0, 10).toLowerCase()
  if (header.kind !== KIND_CALLDATA) return { reason: `envelope kind ${header.kind} is not calldata` }
  if (header.chainId !== BigInt(call.chainId)) return { reason: `envelope chain ${header.chainId} is not ${call.chainId}` }
  if (header.contract !== to) return { reason: `envelope contract ${header.contract} is not ${to}` }
  if (header.selectorOrTypeHash !== selector + '0'.repeat(56)) return { reason: `envelope selector ${header.selectorOrTypeHash.slice(0, 10)} is not ${selector}` }
  if (header.embeddedCall !== false) {
    return { reason: header.embeddedCall ? 'program has an embedded call' : 'program sections cannot be read' }
  }
  // The service's JSON must say the same thing as the signed header.
  const claimedKind = definition.kind
  if (claimedKind !== undefined && claimedKind !== KIND_CALLDATA && claimedKind !== 'calldata') return { reason: 'service kind is not calldata' }
  if (definition.chainId !== undefined && Number(definition.chainId) !== call.chainId) return { reason: 'service chain differs' }
  if (definition.contractAddress !== undefined && String(definition.contractAddress).toLowerCase() !== to) return { reason: 'service contract differs' }
  if (definition.selectorOrTypeHash !== undefined) {
    const claimed = String(definition.selectorOrTypeHash).toLowerCase().replace(/^(0x)?/, '0x')
    if (claimed !== selector && claimed !== selector + '0'.repeat(56)) return { reason: 'service selector differs' }
  }
  if (!erc7730EnvelopeSigner(envelope)) return { reason: 'catalog signature does not verify to the trusted ClearSign root' }
  return {
    entry: {
      definitionId: `0x${id}`,
      envelope: `0x${envelopeHex}`,
      kind: KIND_CALLDATA,
      chainId: call.chainId,
      contractAddress: to,
      selectorOrTypeHash: selector,
    },
  }
}

/** The catalog's primary definition describes exactly this call (the gate's check). */
export function erc7730CatalogDescribesCall(catalog: unknown, chainId: number | undefined, to: string | undefined, data: string | undefined): boolean {
  const c = catalog as Partial<Erc7730Catalog> | null | undefined
  if (!c || typeof c !== 'object' || !Array.isArray(c.definitions) || typeof c.primaryDefinitionId !== 'string') return false
  if (!chainId || typeof to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(to) || erc7730CalldataSkipReason(data)) return false
  const primaryId = c.primaryDefinitionId.replace(/^0x/i, '').toLowerCase()
  const primary = c.definitions.find((d) => String(d?.definitionId ?? '').replace(/^0x/i, '').toLowerCase() === primaryId)
  return !!primary && 'entry' in checkErc7730CalldataDefinition(primary, { chainId, to, data: data! })
}

/**
 * GET the service's definition for (chain, contract, selector). Undefined for
 * 404/422 (none), for any check that fails, and for any network or format
 * error; it never throws.
 */
export async function fetchErc7730CalldataDefinition(
  chainId: number, to: string, data: string, fetchImpl: typeof fetch = fetch,
): Promise<Erc7730Catalog | undefined> {
  const skip = erc7730CalldataSkipReason(data)
  if (skip) return undefined
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(to)) return undefined
  const contract = to.toLowerCase()
  const selector = data.slice(0, 10).toLowerCase()
  const url = `${serviceBase()}/v1/erc7730/definition?kind=calldata&chainId=${chainId}&contract=${contract}&selector=${selector}`
  let response: Response
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(3_000) })
  } catch (error: any) {
    console.warn(`${TAG} definition lookup unavailable (${error?.message || 'connection failed'}); none attached`)
    return undefined
  }
  // 404 until the route ships, 422 NOT_IN_SIGNED_CATALOG after: no definition.
  if (response.status === 404 || response.status === 422) return undefined
  if (!response.ok) {
    console.warn(`${TAG} definition lookup returned HTTP ${response.status}; none attached`)
    return undefined
  }
  let body: any
  try {
    body = await response.json()
  } catch {
    console.warn(`${TAG} definition lookup returned HTTP ${response.status} without valid JSON; none attached`)
    return undefined
  }
  if (!body || typeof body !== 'object') {
    console.warn(`${TAG} definition lookup returned no object; none attached`)
    return undefined
  }
  if (body.embeddedCalls === true) {
    console.info(`${TAG} chain ${chainId} ${contract} ${selector}: definition has embedded calls; not attached`)
    return undefined
  }
  const checked = checkErc7730CalldataDefinition(body, { chainId, to: contract, data })
  if ('reason' in checked) {
    console.warn(`${TAG} chain ${chainId} ${contract} ${selector}: definition not attached (${checked.reason})`)
    return undefined
  }
  if (refusedDefinitionIds.has(checked.entry.definitionId)) {
    console.info(`${TAG} chain ${chainId} ${contract} ${selector}: definition was refused by the device this session; not attached`)
    return undefined
  }
  console.info(`${TAG} chain ${chainId} ${contract} ${selector}: definition ${checked.entry.definitionId.slice(0, 18)}… checked`)
  return { primaryDefinitionId: checked.entry.definitionId, definitions: [checked.entry] }
}

/**
 * The ERC-7730 definition to send with this call, or undefined. Only when the
 * device takes one (7.16+, capability 4), nothing else describes the call (one
 * description per transaction: kind-1 metadata, a certified schema, a contact
 * proof or runtime-signer metadata wins), and the firmware does not decode it
 * natively.
 */
export async function resolveErc7730ForCall(
  call: {
    chainId: number | undefined
    to: string | undefined
    data: string | undefined
    value?: unknown
    firmwareVersion: string | undefined
    capabilities: readonly number[] | undefined
    txMetadata?: unknown
  },
  fetchImpl: typeof fetch = fetch,
): Promise<Erc7730Catalog | undefined> {
  if (!supportsErc7730Transport(call.firmwareVersion, call.capabilities)) return undefined
  if (call.txMetadata) return undefined
  if (!call.chainId || !call.to || typeof call.data !== 'string') return undefined
  if (firmwareClearSigns(call.to, call.data, call.chainId, call.firmwareVersion, call.value)) return undefined
  return fetchErc7730CalldataDefinition(call.chainId, call.to, call.data, fetchImpl)
}

/** keccak256(encodeType(primaryType)) per EIP-712: the primary type, then
 *  every struct it uses, sorted by name. Undefined when a type is missing. */
export function eip712TypeHash(types: Record<string, Array<{ name: string; type: string }>>, primaryType: string): string | undefined {
  const used = new Set<string>()
  const visit = (name: string): boolean => {
    if (used.has(name)) return true
    const members = types?.[name]
    if (!Array.isArray(members)) return false
    used.add(name)
    return members.every((m) => {
      const base = String(m?.type ?? '').replace(/(\[\d*\])+$/, '')
      return !Object.prototype.hasOwnProperty.call(types, base) || visit(base)
    })
  }
  if (!visit(primaryType)) return undefined
  const encode = (name: string) => `${name}(${types[name].map((m) => `${m.type} ${m.name}`).join(',')})`
  const rest = [...used].filter((n) => n !== primaryType).sort()
  return ethersUtils.keccak256(ethersUtils.toUtf8Bytes([primaryType, ...rest].map(encode).join('')))
}

/** What the service is asked for: the domain's chain and verifying contract,
 *  and the primary type's typeHash. A reason when typed data gets none. */
export function erc7730TypedDataKey(typedData: any): { chainId: number; contract: string; typeHash: string } | { reason: string } {
  const primaryType = typedData?.primaryType
  if (typeof primaryType !== 'string' || !primaryType) return { reason: 'no primary type' }
  if (primaryType === 'EIP712Domain') return { reason: 'domain-only signature' }
  // A preload turns off the native Permit2 review (owner, 2026-10-16).
  if (primaryType === 'PermitSingle') return { reason: 'PermitSingle keeps the native Permit2 review' }
  const chainId = Number(typedData?.domain?.chainId)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { reason: 'domain has no chain' }
  const contract = String(typedData?.domain?.verifyingContract ?? '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return { reason: 'domain has no verifying contract' }
  const typeHash = eip712TypeHash(typedData?.types, primaryType)
  if (!typeHash) return { reason: 'types do not resolve' }
  return { chainId, contract: contract.toLowerCase(), typeHash }
}

/** A typed-data definition for exactly this chain, contract and typeHash, or the reason it is not one. */
export function checkErc7730TypedDataDefinition(
  definition: { definitionId?: unknown; envelope?: unknown; kind?: unknown; chainId?: unknown; contractAddress?: unknown; selectorOrTypeHash?: unknown },
  key: { chainId: number; contract: string; typeHash: string },
): { entry: Erc7730Catalog['definitions'][number] } | { reason: string } {
  const envelopeHex = typeof definition.envelope === 'string' ? definition.envelope.replace(/^0x/i, '').toLowerCase() : ''
  const id = typeof definition.definitionId === 'string' ? definition.definitionId.replace(/^0x/i, '').toLowerCase() : ''
  if (!HEX_BYTES.test(envelopeHex) || envelopeHex.length > ENVELOPE_MAX_HEX) return { reason: 'envelope is not bounded hex' }
  if (!/^[0-9a-f]{64}$/.test(id)) return { reason: 'definition id is not 32 bytes' }
  const envelope = Uint8Array.from(Buffer.from(envelopeHex, 'hex'))
  if (createHash('sha256').update(envelope).digest('hex') !== id) return { reason: 'definition id is not sha256(envelope)' }
  const header = readErc7730Envelope(envelope)
  if (!header) return { reason: 'not a K773 envelope' }
  const typeHash = key.typeHash.toLowerCase()
  if (header.kind !== KIND_EIP712) return { reason: `envelope kind ${header.kind} is not EIP-712` }
  if (header.chainId !== BigInt(key.chainId)) return { reason: `envelope chain ${header.chainId} is not ${key.chainId}` }
  if (header.contract !== key.contract) return { reason: `envelope contract ${header.contract} is not ${key.contract}` }
  if (header.selectorOrTypeHash !== typeHash) return { reason: `envelope typeHash ${header.selectorOrTypeHash.slice(0, 10)} is not ${typeHash.slice(0, 10)}` }
  if (header.embeddedCall !== false) {
    return { reason: header.embeddedCall ? 'program has an embedded call' : 'program sections cannot be read' }
  }
  const claimedKind = definition.kind
  if (claimedKind !== undefined && claimedKind !== KIND_EIP712 && claimedKind !== 'eip712') return { reason: 'service kind is not eip712' }
  if (definition.chainId !== undefined && Number(definition.chainId) !== key.chainId) return { reason: 'service chain differs' }
  if (definition.contractAddress !== undefined && String(definition.contractAddress).toLowerCase() !== key.contract) return { reason: 'service contract differs' }
  if (definition.selectorOrTypeHash !== undefined && String(definition.selectorOrTypeHash).toLowerCase().replace(/^(0x)?/, '0x') !== typeHash) {
    return { reason: 'service typeHash differs' }
  }
  if (!erc7730EnvelopeSigner(envelope)) return { reason: 'catalog signature does not verify to the trusted ClearSign root' }
  return {
    entry: {
      definitionId: `0x${id}`, envelope: `0x${envelopeHex}`, kind: KIND_EIP712,
      chainId: key.chainId, contractAddress: key.contract, selectorOrTypeHash: typeHash,
    },
  }
}

/**
 * The ERC-7730 definition to send with this typed data, or undefined. Only on
 * firmware 7.17.0+ (shows each value once), only when nothing else rides with
 * the document (a Permit2 name record), and only one the KeepKey ClearSign
 * service has and this computer checked. Never throws.
 */
export async function resolveErc7730ForTypedData(
  request: { typedData: unknown; firmwareVersion: string | undefined; capabilities: readonly number[] | undefined; txMetadata?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<Erc7730Catalog | undefined> {
  if (!supportsErc7730TypedData(request.firmwareVersion, request.capabilities)) return undefined
  if (request.txMetadata) return undefined
  const key = erc7730TypedDataKey(request.typedData)
  if ('reason' in key) return undefined
  const where = `chain ${key.chainId} ${key.contract} ${key.typeHash.slice(0, 10)}`
  const url = `${serviceBase()}/v1/erc7730/definition?kind=eip712&chainId=${key.chainId}&contract=${key.contract}&typeHash=${key.typeHash}`
  let body: any
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(3_000) })
    if (response.status === 404 || response.status === 422) return undefined
    if (!response.ok) {
      console.warn(`${TAG} ${where}: typed-data definition lookup returned HTTP ${response.status}; none attached`)
      return undefined
    }
    body = await response.json()
  } catch (error: any) {
    console.warn(`${TAG} ${where}: typed-data definition lookup failed (${error?.message || error}); none attached`)
    return undefined
  }
  const checked = checkErc7730TypedDataDefinition(body && typeof body === 'object' ? body : {}, key)
  if ('reason' in checked) {
    console.warn(`${TAG} ${where}: typed-data definition not attached (${checked.reason})`)
    return undefined
  }
  if (refusedDefinitionIds.has(checked.entry.definitionId)) return undefined
  console.info(`${TAG} ${where}: typed-data definition ${checked.entry.definitionId.slice(0, 18)}… checked`)
  return { primaryDefinitionId: checked.entry.definitionId, definitions: [checked.entry] }
}

/** Typed-data sign params with the service's definition attached, when the device takes one. */
export async function withErc7730TypedData<T extends { typedData: any; txMetadata?: unknown }>(
  params: T,
  device: { firmwareVersion: string | undefined; capabilities: readonly number[] | undefined },
  fetchImpl: typeof fetch = fetch,
): Promise<T & { erc7730?: Erc7730Catalog }> {
  const erc7730 = await resolveErc7730ForTypedData({ ...device, typedData: params.typedData, txMetadata: params.txMetadata }, fetchImpl)
  return erc7730 ? { ...params, erc7730 } : params
}

/** Refusals of the definition, not of the transaction (7.16 fsm_msg_ethereum.h,
 *  and hdwallet's own check that the device used the preload). */
const DEFINITION_REFUSAL = /ERC-7730|Value too long to clear-sign|Inner call cannot be clear-signed/i

/** The device (or hdwallet) refused the attached definition. A cancel is the user's answer, never a refusal. */
export function isErc7730Refusal(error: unknown): boolean {
  const text = deviceErrorMessage(error)
  return DEFINITION_REFUSAL.test(text) && !/cancel/i.test(text)
}

/**
 * Sign with the attached definition; if the device refuses the definition,
 * sign again without it on the normal path (owner rule: a transaction that
 * signs today is never rejected for its description). `beforeFallback` runs
 * the normal gate for the plain call first, such as the blind-sign approval
 * card; it throws to stop.
 */
export async function signWithErc7730Fallback<M extends object, R>(
  msg: M,
  sign: (msg: M) => Promise<R>,
  beforeFallback?: (plain: M, reason: string) => Promise<void> | void,
  tag = TAG,
): Promise<R> {
  if (!(msg as { erc7730?: unknown }).erc7730) return sign(msg)
  try {
    return await sign(msg)
  } catch (error) {
    if (!isErc7730Refusal(error)) throw error
    const reason = deviceErrorMessage(error)
    console.warn(`${tag} the device refused the ERC-7730 definition (${reason}); signing without it on the normal path`)
    const { erc7730: refused, ...plain } = msg as any
    const id = String(refused?.primaryDefinitionId ?? '').toLowerCase()
    if (id) refusedDefinitionIds.add(id.startsWith('0x') ? id : `0x${id}`)
    await beforeFallback?.(plain as M, reason)
    return sign(plain as M)
  }
}
