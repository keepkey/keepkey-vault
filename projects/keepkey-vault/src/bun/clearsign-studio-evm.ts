/**
 * ClearSign Studio: runtime-tier EVM v0x02 descriptions signed by a provider key.
 *
 * Bytes come from buildEvmSchemaBody (the same encoder the certified catalog
 * uses), with the trailer naming the runtime slot the provider is loaded into.
 * On 7.16 the device shows such a description only with AdvancedMode on, after
 * the user trusts the provider for the session ("NOT verified by KeepKey"), and
 * the raw review still follows (ethereum.c: runtime tier is annotation only).
 *
 * v0x05 intents and v0x04 decoders are out of scope here on purpose.
 */
import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'

import {
  buildEvmSchemaBody,
  EVM_ARG_ADDRESS,
  EVM_ARG_AMOUNT,
  EVM_ARG_BYTES,
  EVM_ARG_TOKEN_AMOUNT,
  type EvmSchemaSpec,
} from './evm-certified-schema'
import { providerFingerprint } from '../shared/clearsign-provider-key'
import type {
  ClearSignEvmArgFormat,
  ClearSignEvmSchemaArtifact,
  ClearSignEvmSchemaDraft,
  ClearSignEvmSignedEntry,
  ClearSignProviderBundle,
} from '../shared/types'

export const EVM_V2_VERSION = 0x02
/** firmware METADATA_MAX_ARGS */
export const EVM_V2_MAX_ARGS = 8
export const PROVIDER_BUNDLE_FORMAT = 'keepkey-clearsign-provider-bundle-v1' as const
export const PROVIDER_BUNDLE_NOTICE =
  'Runtime-tier descriptions signed by this provider, NOT verified by KeepKey. '
  + 'A KeepKey shows them only with AdvancedMode on, after the user trusts this provider '
  + 'for the session; the raw transaction review still follows. No private key is in this file.'

const FORMAT_BYTE: Record<ClearSignEvmArgFormat, number> = {
  address: EVM_ARG_ADDRESS,
  amount: EVM_ARG_AMOUNT,
  bytes: EVM_ARG_BYTES,
  'token-amount': EVM_ARG_TOKEN_AMOUNT,
}
const BYTE_FORMAT = new Map(Object.entries(FORMAT_BYTE).map(([k, v]) => [v, k as ClearSignEvmArgFormat]))
const SIGNATURE_BYTES = 65

function requireRuntimeSlot(keyId: number): void {
  if (!Number.isInteger(keyId) || keyId < 0 || keyId > 3) throw new Error('Signer slot must be an integer from 0 to 3')
}

function cleanHex(value: string, bytes: number, field: string): string {
  const hex = String(value || '').trim().replace(/^0x/i, '').toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(hex)) throw new Error(`${field} must be ${bytes} bytes of hex`)
  return `0x${hex}`
}

/** Normalize a draft and map it onto the shared encoder's spec. */
export function normalizeEvmDraft(draft: ClearSignEvmSchemaDraft): { draft: ClearSignEvmSchemaDraft; spec: EvmSchemaSpec } {
  if (!draft || !Array.isArray(draft.args)) throw new Error('EVM description is required')
  if (draft.args.length > EVM_V2_MAX_ARGS) throw new Error(`v2 allows at most ${EVM_V2_MAX_ARGS} arguments`)
  const args = draft.args.map((arg, i) => {
    const format = FORMAT_BYTE[arg?.format]
    if (!format) throw new Error(`argument ${i} has an unsupported format`)
    const name = String(arg.name ?? '')
    if (arg.format !== 'token-amount') return { name, format: arg.format }
    const symbol = String(arg.symbol ?? '')
    if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) throw new Error(`argument ${i} (${name}) token symbol must be 1-10 letters or digits`)
    return { name, format: arg.format, decimals: Number(arg.decimals), symbol }
  })
  const normalized: ClearSignEvmSchemaDraft = {
    chainId: Number(draft.chainId),
    contract: cleanHex(draft.contract, 20, 'contract'),
    selector: cleanHex(draft.selector, 4, 'selector'),
    method: String(draft.method ?? ''),
    args,
  }
  const spec: EvmSchemaSpec = {
    chainId: normalized.chainId,
    contract: normalized.contract,
    selector: normalized.selector,
    method: normalized.method,
    args: args.map(arg => ({ name: arg.name, format: FORMAT_BYTE[arg.format], decimals: arg.decimals, symbol: arg.symbol })),
    expectedCalldataLength: 4 + 32 * args.length,
  }
  return { draft: normalized, spec }
}

/** Unsigned v0x02 body for a runtime slot, validated by the shared encoder. */
export function buildStudioEvmSchema(draft: ClearSignEvmSchemaDraft, keyId: number): ClearSignEvmSchemaArtifact {
  requireRuntimeSlot(keyId)
  const { draft: normalized, spec } = normalizeEvmDraft(draft)
  const body = buildEvmSchemaBody(spec, keyId)
  if (body[0] !== EVM_V2_VERSION) throw new Error('Studio authors v0x02 descriptions only')
  return {
    format: 'evm-v2',
    body: body.toString('hex'),
    byteLength: body.length,
    calldataLength: spec.expectedCalldataLength!,
    keyId,
    draft: normalized,
  }
}

/**
 * body || r || s || (27 + recovery) over sha256(body), byte-identical to the
 * provider server (keepkey-clearsign-server src/v2.ts signV2, lowS:false).
 */
export function signEvmBody(body: Uint8Array, privateKey: Uint8Array): string {
  const signature = secp256k1.sign(sha256(body), privateKey, { lowS: false })
  const recovery = Uint8Array.of(27 + (signature.recovery ?? 0))
  return Buffer.concat([body, signature.toCompactRawBytes(), recovery]).toString('hex')
}

function decodeV2Body(body: Buffer): { draft: ClearSignEvmSchemaDraft; keyId: number } {
  let at = 0
  const take = (n: number) => {
    if (at + n > body.length) throw new Error('signed description is truncated')
    const out = body.subarray(at, at + n)
    at += n
    return out
  }
  if (take(1)[0] !== EVM_V2_VERSION) throw new Error('signed description is not v0x02')
  const chainId = take(4).readUInt32BE(0)
  const contract = `0x${take(20).toString('hex')}`
  const selector = `0x${take(4).toString('hex')}`
  const method = take(take(2).readUInt16BE(0)).toString('ascii')
  const count = take(1)[0]
  const args: ClearSignEvmSchemaDraft['args'] = []
  for (let i = 0; i < count; i++) {
    const name = take(take(1)[0]).toString('ascii')
    const format = BYTE_FORMAT.get(take(1)[0])
    if (!format) throw new Error(`argument ${i} has a format Studio does not author`)
    if (format !== 'token-amount') {
      args.push({ name, format })
      continue
    }
    const decimals = take(1)[0]
    args.push({ name, format, decimals, symbol: take(take(1)[0]).toString('ascii') })
  }
  take(5) // classification + timestamp; the canonical re-encode below pins them
  const keyId = take(1)[0]
  if (at !== body.length) throw new Error('signed description has trailing bytes')
  return { draft: { chainId, contract, selector, method, args }, keyId }
}

/**
 * Decode a signed v0x02 description and check, host-side, that it is canonical
 * and signed by `publicKeyHex`. The device repeats the signature check itself.
 */
export function inspectSignedEvmEntry(signedPayload: string, publicKeyHex: string): ClearSignEvmSignedEntry {
  const raw = String(signedPayload || '').trim().replace(/^0x/i, '').toLowerCase()
  if (!raw || raw.length % 2 !== 0 || !/^[0-9a-f]+$/.test(raw)) throw new Error('signed description must be hex')
  const bytes = Buffer.from(raw, 'hex') as Uint8Array as Buffer
  if (bytes.length <= SIGNATURE_BYTES) throw new Error('signed description is truncated')
  const body = bytes.subarray(0, bytes.length - SIGNATURE_BYTES)
  const { draft, keyId } = decodeV2Body(body)
  const rebuilt = buildStudioEvmSchema(draft, keyId)
  if (rebuilt.body !== body.toString('hex')) throw new Error('signed description is not in canonical Studio form')
  const signature = bytes.subarray(body.length, body.length + 64)
  const recovery = bytes[bytes.length - 1]
  const publicKeyClean = cleanHex(publicKeyHex, 33, 'provider public key').slice(2)
  if ((recovery !== 27 && recovery !== 28)
    || !secp256k1.verify(new Uint8Array(signature), sha256(new Uint8Array(body)), Uint8Array.from(Buffer.from(publicKeyClean, 'hex')), { prehash: false, lowS: false })) {
    throw new Error(`signature on ${draft.method} does not verify against provider ${providerFingerprint(publicKeyClean)}`)
  }
  return { keyId, signedPayload: raw, draft: rebuilt.draft }
}

function requireAlias(value: unknown): string {
  const alias = String(value ?? '').trim()
  if (!alias || alias.length > 31 || !/^[A-Za-z0-9 _-]+$/.test(alias)) {
    throw new Error('Alias must be 1-31 letters, digits, spaces, hyphens, or underscores')
  }
  return alias
}

/** Public bundle: provider identity plus descriptions that verify against it. */
export function buildProviderBundle(opts: {
  alias: string
  publicKeyHex: string
  /** The bundle's device slot. Export omits it: the slot the entries were signed for. */
  keyId?: number
  signedPayloads: string[]
}): ClearSignProviderBundle {
  const publicKeyHex = cleanHex(opts.publicKeyHex, 33, 'provider public key').slice(2)
  if (!Array.isArray(opts.signedPayloads) || opts.signedPayloads.length === 0) throw new Error('bundle has no descriptions')
  const inspected = opts.signedPayloads.map(payload => inspectSignedEvmEntry(payload, publicKeyHex))
  const slots = [...new Set(inspected.map(entry => entry.keyId))]
  if (opts.keyId === undefined && slots.length > 1) {
    throw new Error(`descriptions are signed for slots ${slots.join(', ')}; a bundle holds one slot`)
  }
  const keyId = opts.keyId ?? slots[0]
  requireRuntimeSlot(keyId)
  const entries = inspected.map(entry => {
    if (entry.keyId !== keyId) throw new Error(`${entry.draft.method} is signed for slot ${entry.keyId}, not ${keyId}`)
    const { chainId, contract, selector, method } = entry.draft
    return { chainId, contract, selector, method, signedPayload: entry.signedPayload }
  })
  const seen = new Set<string>()
  for (const e of entries) {
    const key = `${e.chainId}:${e.contract}:${e.selector}`
    if (seen.has(key)) throw new Error(`bundle describes ${key} twice`)
    seen.add(key)
  }
  return {
    format: PROVIDER_BUNDLE_FORMAT,
    provider: { alias: requireAlias(opts.alias), publicKeyHex, fingerprint: providerFingerprint(publicKeyHex), keyId },
    entries,
    notice: PROVIDER_BUNDLE_NOTICE,
  }
}

/** The export file name: the alias as a slug (a fixed word when the alias
 * has no letters or digits) and the provider fingerprint. */
export function providerBundleFileName(bundle: ClearSignProviderBundle): string {
  const slug = bundle.provider.alias.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider'
  return `keepkey-clearsign-bundle-${slug}-${bundle.provider.fingerprint}.json`
}

/** Validate an imported bundle file: every entry must verify and match its row. */
export function parseProviderBundle(json: string): { bundle: ClearSignProviderBundle; entries: ClearSignEvmSignedEntry[] } {
  let parsed: any
  try { parsed = JSON.parse(json) } catch { throw new Error('bundle is not valid JSON') }
  if (parsed?.format !== PROVIDER_BUNDLE_FORMAT) throw new Error(`bundle format must be ${PROVIDER_BUNDLE_FORMAT}`)
  // Rebuilt from the verified fields only: anything else in the file is dropped.
  const rows: any[] = Array.isArray(parsed.entries) ? parsed.entries : []
  // An imported file must state its slot; it is checked against every entry.
  requireRuntimeSlot(parsed.provider?.keyId)
  const bundle = buildProviderBundle({
    alias: parsed.provider?.alias,
    publicKeyHex: parsed.provider?.publicKeyHex,
    keyId: parsed.provider?.keyId,
    signedPayloads: rows.map(row => row?.signedPayload),
  })
  if (parsed.provider?.fingerprint !== bundle.provider.fingerprint) throw new Error('bundle fingerprint does not match its public key')
  bundle.entries.forEach((entry, i) => {
    const row = rows[i]
    if (row.chainId !== entry.chainId || String(row.contract).toLowerCase() !== entry.contract
      || String(row.selector).toLowerCase() !== entry.selector || row.method !== entry.method) {
      throw new Error(`bundle entry ${i} does not match its signed description`)
    }
  })
  const entries = bundle.entries.map(e => inspectSignedEvmEntry(e.signedPayload, bundle.provider.publicKeyHex))
  return { bundle, entries }
}
