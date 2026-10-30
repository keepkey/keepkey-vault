/**
 * ERC-7730 calldata definitions from the KeepKey ClearSign service, checked
 * here before one reaches the device.
 *
 * The service signs ERC-7730 v2 programs (C773) into K773 envelopes. Firmware
 * 7.16 verifies the envelope itself; Desktop's checks decide only whether to
 * send one, so a definition the device would refuse (or that describes another
 * call) never replaces the normal review:
 *  - sha256(envelope) is the definition id;
 *  - the program header names this chain, contract and selector;
 *  - below 7.17, the program has no embedded-call formatter and no formatter
 *    flags: on 7.16 a missing inner definition fails the whole signature after
 *    the outer screens (owner, 2026-10-16: skip embedded calls), and a flag
 *    fails the program. When the bytes cannot say, no definition.
 * On 7.17+ an embedded call's definition (and a second level's) is fetched
 * from the same service, with the same checks, before the definition is
 * attached: the device will ask for each one, and the card describes the
 * call from them. When one is missing, or the calldata shows the device would
 * refuse (a Safe DELEGATECALL, a value that does not match), nothing is
 * attached, so the user sees the normal review once, not after the device's
 * own screens. A 404 or 422 means no definition; nothing here throws.
 */
import { createHash } from 'node:crypto'
import { DEFAULT_CLEARSIGN_SERVICE_URL } from './solana-certified-registry'
import { firmwareClearSigns } from './calldata-decoder'
import { erc7730CalldataSkipReason, supportsErc7730EmbeddedCalls, supportsErc7730Transport } from '../shared/erc7730-support'
import { deviceErrorMessage } from '../shared/device-error'
import { planErc7730EmbeddedCalls } from './erc7730-describe'
import type { Erc7730Catalog } from '../shared/types'

const TAG = '[erc7730]'
/** Envelope hex limit, as the REST schema has always bounded it. */
const ENVELOPE_MAX_HEX = 35_000
const PROGRAM_HEADER_SIZE = 179
const KIND_CALLDATA = 1
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
 *  (a swap after the AdvancedMode opt-in) does not repeat the refused review.
 *  A refusal of one transaction's inner call, or of its value, is about that
 *  transaction only: keyed by definition id and calldata (refusalKey). */
const refusedDefinitionIds = new Set<string>()
const refusalKey = (definitionId: string, data?: unknown) =>
  data === undefined ? definitionId : `${definitionId}:${createHash('sha256').update(String(data).toLowerCase().replace(/^0x/, '')).digest('hex')}`

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
  /** A formatter sets flag bits (7.17: RECIPIENT, TX_VALUE); undefined as above. */
  formatterFlags: boolean | undefined
}

const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

/**
 * Whether a C773 program uses the embedded-call formatter, and whether any
 * formatter sets flag bits (byte 1 of its entry); undefined when its sections
 * cannot be read the way 7.16 reads them (erc7730_program.c): section types
 * 1..9 strictly increasing, exactly the declared count, ending exactly at the
 * program length; at most 64 formatters, each with 1..23 arguments, ending
 * exactly at the formatter section's end.
 */
export function readProgramFormatters(program: Uint8Array): { embeddedCall: boolean; formatterFlags: boolean } | undefined {
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
  let flags = false
  let p = 2
  for (let i = 0; i < count; i++) {
    if (p + 3 > formatters.length) return undefined
    const args = formatters[p + 2]
    if (args === 0 || args > MAX_FORMATTER_ARGUMENTS) return undefined
    if (formatters[p] === FORMATTER_EMBEDDED_CALL) embedded = true
    if (formatters[p + 1] !== 0) flags = true
    p += 3 + 4 * args
  }
  if (p !== formatters.length) return undefined
  // The resource summary's own flag for the same thing.
  if (resources && resources.length >= 20 && resources[19] !== 0) embedded = true
  return { embeddedCall: embedded, formatterFlags: flags }
}

/** Whether a C773 program uses the embedded-call formatter; undefined when its
 *  sections cannot be read (readProgramFormatters). */
export function programHasEmbeddedCall(program: Uint8Array): boolean | undefined {
  return readProgramFormatters(program)?.embeddedCall
}

/** The K773 envelope's program header, or undefined when it is not one. */
export function readErc7730Envelope(envelope: Uint8Array): Erc7730EnvelopeHeader | undefined {
  // 'K773' 01 01 | program_length be32 | program ('C773' 01 02 ...) | proof | certificate | signature
  if (envelope.length < 10 + PROGRAM_HEADER_SIZE || hex(envelope.subarray(0, 6)) !== '4b3737330101') return undefined
  const programLength = be32(envelope, 6)
  if (programLength < PROGRAM_HEADER_SIZE || 10 + programLength > envelope.length) return undefined
  const program = envelope.subarray(10, 10 + programLength)
  if (hex(program.subarray(0, 6)) !== '433737330102') return undefined
  const formatters = readProgramFormatters(program)
  return {
    kind: program[7],
    chainId: Buffer.from(program.subarray(10, 18)).readBigUInt64BE(0),
    contract: `0x${hex(program.subarray(18, 38))}`,
    selectorOrTypeHash: `0x${hex(program.subarray(38, 70))}`,
    embeddedCall: formatters?.embeddedCall,
    formatterFlags: formatters?.formatterFlags,
  }
}

const HEX_BYTES = /^(?:[0-9a-f]{2})+$/

/**
 * A definition for exactly this call, or the reason it is not one. `claimed`
 * holds the service's own JSON fields, which must agree with the header.
 * `embedded`: the device takes embedded calls and formatter flags (7.17+).
 */
export function checkErc7730CalldataDefinition(
  definition: { definitionId?: unknown; envelope?: unknown; kind?: unknown; chainId?: unknown; contractAddress?: unknown; selectorOrTypeHash?: unknown },
  call: { chainId: number; to: string; data: string },
  embedded = false,
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
  if (header.embeddedCall === undefined || header.formatterFlags === undefined) return { reason: 'program sections cannot be read' }
  if (header.embeddedCall && !embedded) return { reason: 'program has an embedded call' }
  if (header.formatterFlags && !embedded) return { reason: 'program uses formatter flags' }
  // The service's JSON must say the same thing as the signed header.
  const claimedKind = definition.kind
  if (claimedKind !== undefined && claimedKind !== KIND_CALLDATA && claimedKind !== 'calldata') return { reason: 'service kind is not calldata' }
  if (definition.chainId !== undefined && Number(definition.chainId) !== call.chainId) return { reason: 'service chain differs' }
  if (definition.contractAddress !== undefined && String(definition.contractAddress).toLowerCase() !== to) return { reason: 'service contract differs' }
  if (definition.selectorOrTypeHash !== undefined) {
    const claimed = String(definition.selectorOrTypeHash).toLowerCase().replace(/^(0x)?/, '0x')
    if (claimed !== selector && claimed !== selector + '0'.repeat(56)) return { reason: 'service selector differs' }
  }
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
export function erc7730CatalogDescribesCall(
  catalog: unknown, chainId: number | undefined, to: string | undefined, data: string | undefined, firmwareVersion?: string,
): boolean {
  const c = catalog as Partial<Erc7730Catalog> | null | undefined
  if (!c || typeof c !== 'object' || !Array.isArray(c.definitions) || typeof c.primaryDefinitionId !== 'string') return false
  if (!chainId || typeof to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(to) || erc7730CalldataSkipReason(data)) return false
  const primaryId = c.primaryDefinitionId.replace(/^0x/i, '').toLowerCase()
  const primary = c.definitions.find((d) => String(d?.definitionId ?? '').replace(/^0x/i, '').toLowerCase() === primaryId)
  return !!primary && 'entry' in checkErc7730CalldataDefinition(primary, { chainId, to, data: data! }, supportsErc7730EmbeddedCalls(firmwareVersion))
}

/** GET the service's answer for one lookup: the JSON object, or undefined for
 *  none (404/422), an error status, bad JSON or a network failure. */
async function fetchDefinitionBody(chainId: number, contract: string, selector: string, fetchImpl: typeof fetch): Promise<any> {
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
  return body
}

/**
 * GET the service's definition for (chain, contract, selector). Undefined for
 * 404/422 (none), for any check that fails, and for any network or format
 * error; it never throws. `firmwareVersion` 7.17+ also takes a definition with
 * embedded calls or formatter flags, with the inner definitions the device
 * will ask for (`value` is the call's), or none when the device would refuse it.
 */
export async function fetchErc7730CalldataDefinition(
  chainId: number, to: string, data: string, fetchImpl: typeof fetch = fetch, firmwareVersion?: string, value?: unknown,
): Promise<Erc7730Catalog | undefined> {
  const skip = erc7730CalldataSkipReason(data)
  if (skip) return undefined
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(to)) return undefined
  const contract = to.toLowerCase()
  const selector = data.slice(0, 10).toLowerCase()
  const embedded = supportsErc7730EmbeddedCalls(firmwareVersion)
  const body = await fetchDefinitionBody(chainId, contract, selector, fetchImpl)
  if (!body) return undefined
  if (body.embeddedCalls === true && !embedded) {
    console.info(`${TAG} chain ${chainId} ${contract} ${selector}: definition has embedded calls; not attached`)
    return undefined
  }
  const checked = checkErc7730CalldataDefinition(body, { chainId, to: contract, data }, embedded)
  if ('reason' in checked) {
    console.warn(`${TAG} chain ${chainId} ${contract} ${selector}: definition not attached (${checked.reason})`)
    return undefined
  }
  const id = checked.entry.definitionId
  if (refusedDefinitionIds.has(id) || refusedDefinitionIds.has(refusalKey(id, data))) {
    console.info(`${TAG} chain ${chainId} ${contract} ${selector}: definition was refused by the device this session; not attached`)
    return undefined
  }
  const header = readErc7730Envelope(Uint8Array.from(Buffer.from(checked.entry.envelope.slice(2), 'hex')))
  const inner = header?.embeddedCall || header?.formatterFlags
    ? await innerDefinitionsFor(checked.entry.envelope, { chainId, to: contract, data, value }, fetchImpl)
    : []
  if (typeof inner === 'string') {
    console.info(`${TAG} chain ${chainId} ${contract} ${selector}: definition not attached (${inner})`)
    return undefined
  }
  console.info(`${TAG} chain ${chainId} ${contract} ${selector}: definition ${id.slice(0, 18)}… checked${inner.length ? `, with ${inner.length} inner` : ''}`)
  return { primaryDefinitionId: id, definitions: [checked.entry, ...inner] }
}

/**
 * The inner definitions the device will ask for while it signs this call with
 * this definition (7.17, two levels deep), fetched and checked like any other;
 * or why it would refuse the call with it: an inner call with no definition,
 * or a refusal the calldata already shows.
 */
async function innerDefinitionsFor(
  envelope: string, call: { chainId: number; to: string; data: string; value?: unknown }, fetchImpl: typeof fetch,
): Promise<Erc7730Catalog['definitions'] | string> {
  const found: Erc7730Catalog['definitions'] = []
  // Each round reads one level further down: the calls, then theirs.
  for (let round = 0; round <= 2; round++) {
    const plan = planErc7730EmbeddedCalls(envelope, call, found)
    if (plan.refused) return `the device would refuse it: ${plan.refused}`
    if (!plan.missing.length) return found
    const keys = new Set(plan.missing.map((m) => `${m.contractAddress}:${m.selector}`))
    for (const key of keys) {
      const [contractAddress, selector] = key.split(':')
      const entry = await resolveErc7730InnerDefinition(call.chainId, contractAddress, selector, fetchImpl)
      if (!entry) return `no definition for its inner call ${contractAddress} ${selector}`
      found.push(entry)
    }
  }
  return 'inner calls nest deeper than the device follows'
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
  return fetchErc7730CalldataDefinition(call.chainId, call.to, call.data, fetchImpl, call.firmwareVersion, call.value)
}

/**
 * The definition of an embedded call the device asks for while it signs
 * (7.17+: by chain, callee and selector, all read from the signed calldata),
 * from the same service with the same checks; undefined answers "none", and
 * the device then refuses the definition ("Inner call cannot be clear-signed").
 * A second level may embed calls of its own; the device bounds the depth.
 */
export async function resolveErc7730InnerDefinition(
  chainId: number, contractAddress: string, selector: string, fetchImpl: typeof fetch = fetch,
): Promise<Erc7730Catalog['definitions'][number] | undefined> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress) || !/^0x[0-9a-fA-F]{8}$/.test(selector)) return undefined
  const contract = contractAddress.toLowerCase()
  const sel = selector.toLowerCase()
  const body = await fetchDefinitionBody(chainId, contract, sel, fetchImpl)
  if (!body) return undefined
  const checked = checkErc7730CalldataDefinition(body, { chainId, to: contract, data: sel }, true)
  if ('reason' in checked) {
    console.warn(`${TAG} chain ${chainId} ${contract} ${sel}: inner definition not served (${checked.reason})`)
    return undefined
  }
  console.info(`${TAG} chain ${chainId} ${contract} ${sel}: inner definition ${checked.entry.definitionId.slice(0, 18)}… checked`)
  return checked.entry
}

/** The catalog's primary definition embeds calls: the device will ask for theirs. */
function primaryHasEmbeddedCall(catalog: Partial<Erc7730Catalog> | undefined): boolean {
  const primaryId = String(catalog?.primaryDefinitionId ?? '').replace(/^0x/i, '').toLowerCase()
  const primary = catalog?.definitions?.find((d) => String(d?.definitionId ?? '').replace(/^0x/i, '').toLowerCase() === primaryId)
  const envelope = typeof primary?.envelope === 'string' ? primary.envelope.replace(/^0x/i, '') : ''
  return !!envelope && readErc7730Envelope(Uint8Array.from(Buffer.from(envelope, 'hex')))?.embeddedCall === true
}

/** Refusals of the definition, not of the transaction (7.16/7.17
 *  fsm_msg_ethereum.h, and hdwallet's own check that the device used the
 *  preload). 7.17 names an inner DELEGATECALL and refuses to describe it. */
const DEFINITION_REFUSAL = /ERC-7730|Value too long to clear-sign|Inner call cannot be clear-signed|DELEGATECALL cannot be clear-signed/i
/** Refusals of one transaction (its inner call, or its value), not of the
 *  definition: the next call to the same contract may still clear-sign. */
const CALL_REFUSAL = /Inner call cannot be clear-signed|DELEGATECALL cannot be clear-signed|ERC-7730 inner definition does not match|ERC-7730 value does not match the call|recursion depth exceeds host limit/i

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
 * card; it throws to stop. A definition with embedded calls (7.17+) goes with
 * a resolver for the definitions the device asks for while it signs.
 */
export async function signWithErc7730Fallback<M extends object, R>(
  msg: M,
  sign: (msg: M) => Promise<R>,
  beforeFallback?: (plain: M, reason: string) => Promise<void> | void,
  tag = TAG,
  fetchImpl: typeof fetch = fetch,
): Promise<R> {
  const catalog = (msg as { erc7730?: Erc7730Catalog }).erc7730
  if (!catalog) return sign(msg)
  const withInner = primaryHasEmbeddedCall(catalog) && !(catalog as any).resolveInner
    ? { ...msg, erc7730: { ...catalog, resolveInner: (chainId: number, contract: string, selector: string) => resolveErc7730InnerDefinition(chainId, contract, selector, fetchImpl) } }
    : msg
  try {
    return await sign(withInner)
  } catch (error) {
    if (!isErc7730Refusal(error)) throw error
    const reason = deviceErrorMessage(error)
    console.warn(`${tag} the device refused the ERC-7730 definition (${reason}); signing without it on the normal path`)
    const { erc7730: refused, ...plain } = msg as any
    const id = String(refused?.primaryDefinitionId ?? '').toLowerCase()
    if (id) {
      const definitionId = id.startsWith('0x') ? id : `0x${id}`
      refusedDefinitionIds.add(CALL_REFUSAL.test(reason) ? refusalKey(definitionId, (plain as { data?: unknown }).data) : definitionId)
    }
    await beforeFallback?.(plain as M, reason)
    return sign(plain as M)
  }
}
