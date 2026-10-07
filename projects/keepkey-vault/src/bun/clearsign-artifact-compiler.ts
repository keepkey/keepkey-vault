import { createHash } from 'node:crypto'

import type { ClearSignAuditEvidence, ClearSignCentralAssetAudit, ClearSignCentralAssetAuditHistory, ClearSignCentralContractAudit, ClearSignPromotionBundle, ClearSignPromotionReview } from '../shared/types'
import { evaluateClearSignPromotion } from './clearsign-promotion'
import { buildEvmSchemaBody } from './evm-certified-schema'
import { compileApprovedErc20TokenSchema } from './clearsign-token-promotion'
import {
  ARG_OPAQUE32,
  ARG_PUBKEY,
  ARG_U8,
  ARG_U64,
  serializeSolanaSchema,
  solanaSchemaCoverage,
  type SolanaSchemaArg,
  type SolanaSchemaSpec,
} from './solana-certified-schema'
import { PROGRAM_REGISTRY } from './solana-instruction-decoder'

const EVM_SCHEMA_VERSION = 0x02
const EVM_CLASSIFICATION_VERIFIED = 0x01
const CERTIFIED_DELEGATE_KEY_ID = 0x80
const EVM_ARG_ADDRESS = 1
const EVM_ARG_AMOUNT = 2
const EVM_ARG_BYTES = 3

function ascii(value: string, max: number, label: string): Buffer {
  const bytes = Buffer.from(value, 'ascii')
  if (!value || bytes.toString('ascii') !== value || bytes.length > max || /[%\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be 1..${max} printable ASCII characters without %`)
  }
  return bytes
}

function hex(value: string, bytes: number, label: string): Buffer {
  const clean = value.replace(/^0x/i, '')
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(clean)) throw new Error(`${label} must be ${bytes} bytes of hex`)
  return Buffer.from(clean, 'hex')
}

function be16(value: number): Buffer { const out = Buffer.alloc(2); out.writeUInt16BE(value); return out }
function be32(value: number): Buffer { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out }

function evmFormat(type: string): number {
  if (type === 'address') return EVM_ARG_ADDRESS
  if (/^(?:u?int)(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/.test(type)) return EVM_ARG_AMOUNT
  if (/^bytes(?:[1-9]|[12][0-9]|3[0-2])$/.test(type) || type === 'bool') return EVM_ARG_BYTES
  throw new Error(`EVM ABI type ${type} is not supported by the firmware's complete v2 decoder`)
}

/** Build exactly the bytes an offline delegate must SHA-256 and sign. */
export function compileUnsignedEvmV2Body(bundle: ClearSignPromotionBundle, observedShape: Record<string, unknown>): Buffer {
  const candidate = bundle.candidate
  if (bundle.chain !== 'Ethereum') throw new Error('promotion is not for Ethereum')
  if (observedShape.primaryType && !observedShape.selector) {
    throw new Error('generic EIP-712 promotion requires a typed-data-capable firmware format')
  }
  if ((candidate.source !== 'sourcify' && candidate.source !== 'erc7730-registry') || !candidate.signature) {
    throw new Error('EVM promotion requires a selector-matched verified ABI or active ERC-7730 descriptor')
  }
  if (candidate.inputs.length > 8) throw new Error('EVM firmware supports at most 8 arguments')
  let methodName = candidate.name
  let compiledInputs = candidate.inputs
  if (candidate.source === 'erc7730-registry') {
    const display = candidate.erc7730Display
    if (!display || !display.intent) throw new Error('ERC-7730 promotion requires the matched display intent and fields')
    if (display.hasIncludes || display.interpolatedIntent || display.requiredOrExcluded || display.fieldsTruncated) {
      throw new Error('ERC-7730 includes, interpolation, required, and excluded semantics are not representable by firmware v2')
    }
    if (display.fields.length !== candidate.inputs.length) throw new Error('ERC-7730 firmware subset requires every ABI argument exactly once')
    compiledInputs = candidate.inputs.map((input, index) => {
      const field = display.fields[index]
      const path = String(field.path || '').replace(/^#\.?/, '')
      if (!input.name || path !== input.name || path.includes('.')) throw new Error('ERC-7730 firmware subset requires direct fields in ABI order')
      if (!field.label) throw new Error('ERC-7730 display field requires a label')
      if (field.hasParams || field.encrypted || (field.visible && field.visible !== 'always')) {
        throw new Error('ERC-7730 field parameters, encryption, and visibility rules are not representable by firmware v2')
      }
      if (input.type === 'address' && (field.format === 'addressName' || field.format === 'raw')) {
        return { ...input, name: field.label }
      }
      if (/^u?int(?:[0-9]+)?$/.test(input.type) && field.format === 'amount') {
        return { ...input, name: field.label }
      }
      throw new Error(`ERC-7730 format ${field.format || 'missing'} for ${input.type} is not faithfully representable by firmware v2`)
    })
    methodName = display.intent
  }
  const method = ascii(methodName, 64, 'method name')
  const chainId = Number(observedShape.chainId)
  if (!Number.isInteger(chainId) || chainId < 1 || chainId > 0xffffffff) throw new Error('invalid EVM chain id')
  const transactionContract = String(observedShape.contract).toLowerCase()
  hex(transactionContract, 20, 'observed transaction contract')
  if (String(observedShape.selector).toLowerCase() !== candidate.selectorOrDiscriminator.toLowerCase()) throw new Error('candidate selector differs from observed shape')
  if (Number(observedShape.calldataLength) !== 4 + compiledInputs.length * 32) throw new Error('EVM schema would not cover the complete observed calldata')
  const parts: Buffer[] = [
    // An ABI may be proven at a proxy implementation, but the device must
    // bind the address the transaction actually calls.
    Buffer.from([EVM_SCHEMA_VERSION]), be32(chainId), hex(transactionContract, 20, 'contract'),
    hex(candidate.selectorOrDiscriminator, 4, 'selector'), be16(method.length), method,
    Buffer.from([compiledInputs.length]),
  ]
  for (let i = 0; i < compiledInputs.length; i++) {
    const input = compiledInputs[i]
    const name = ascii(input.name || `arg${i + 1}`, 32, 'argument name')
    parts.push(Buffer.from([name.length]), name, Buffer.from([evmFormat(input.type)]))
  }
  parts.push(Buffer.from([EVM_CLASSIFICATION_VERIFIED]), be32(0), Buffer.from([CERTIFIED_DELEGATE_KEY_ID]))
  return Buffer.concat(parts as any)
}

function solanaArg(type: string, name: string): SolanaSchemaArg {
  const label = name || 'Value'
  if (type === 'u8' || type === 'bool') return { type: ARG_U8, label }
  if (type === 'u64') return { type: ARG_U64, label }
  if (type === 'pubkey') return { type: ARG_PUBKEY, label }
  if (type === 'bytes32') return { type: ARG_OPAQUE32, label }
  throw new Error(`Solana argument type ${type} is not fixed-width and firmware-supported`)
}

export function compileUnsignedSolanaSchema(bundle: ClearSignPromotionBundle, observedShape: Record<string, unknown>): Buffer {
  const candidate = bundle.candidate
  if (bundle.chain !== 'Solana') throw new Error('promotion is not for Solana')
  if (candidate.source !== 'program-registry' && candidate.source !== 'anchor-idl') throw new Error('unsupported Solana candidate source')
  const registry = PROGRAM_REGISTRY.programs[candidate.address]
  const programName = registry?.name || candidate.address.slice(0, 12)
  const spec: SolanaSchemaSpec = {
    programId: candidate.address,
    discriminator: hex(candidate.selectorOrDiscriminator, candidate.selectorOrDiscriminator.replace(/^0x/, '').length / 2, 'discriminator'),
    programName,
    instructionName: candidate.name,
    args: candidate.inputs.map((input) => solanaArg(input.type, input.name)),
    accounts: (candidate.accounts || []).map((account, index) => ({ index, label: account.name })),
  }
  const payload = serializeSolanaSchema(spec)
  const components = Array.isArray(observedShape.components) ? observedShape.components as Array<Record<string, unknown>> : []
  const matching = components.filter((component) => String(component.program) === candidate.address
    && (String(component.prefix8).toLowerCase().startsWith(candidate.selectorOrDiscriminator.replace(/^0x/, '').toLowerCase())
      || String(component.prefix1).toLowerCase() === candidate.selectorOrDiscriminator.replace(/^0x/, '').toLowerCase()))
  if (matching.length !== 1) throw new Error(`expected exactly one observed instruction matching the candidate, found ${matching.length}`)
  const expectedLength = Number(matching[0].dataLength)
  if (!Number.isInteger(expectedLength)) throw new Error('shapeKey does not bind a Solana instruction data length')
  if (solanaSchemaCoverage(spec) !== expectedLength) throw new Error(`schema covers ${solanaSchemaCoverage(spec)} bytes but observed instruction has ${expectedLength}`)
  const privileges = Array.isArray(matching[0].accountPrivileges)
    ? matching[0].accountPrivileges as Array<Record<string, unknown>> : []
  for (let index = 0; index < (candidate.accounts || []).length; index++) {
    const expected = candidate.accounts![index]
    const observed = privileges[index]
    if (!observed || Number(observed.index) !== index) throw new Error(`observed shape does not bind account position ${index}`)
    if (expected.writable !== undefined && Boolean(observed.writable) !== expected.writable) {
      throw new Error(`account ${index} writable privilege differs from the candidate`)
    }
    if (expected.signer !== undefined && Boolean(observed.signer) !== expected.signer) {
      throw new Error(`account ${index} signer privilege differs from the candidate`)
    }
  }
  return payload
}

export interface ClearSignUnsignedArtifact {
  version: 1
  bundleHash: string
  shapeKey: string
  identityHash: string
  expiresAt: number
  format: 'evm-v2-certified-inner' | 'solana-kksolsc1'
  payloadHex: string
  payloadHash: string
  digestAlgorithm: 'sha256'
  signatureAlgorithm: 'secp256k1-compact'
  keyId: 128
  reviewerFingerprints: string[]
}

/** Compile the reviewed contract+token evidence join; signing and publication remain separate. */
export function compileApprovedErc20TokenArtifact(input: {
  contractAudit: ClearSignCentralContractAudit
  asset: ClearSignCentralAssetAudit
  assetAudit: ClearSignCentralAssetAuditHistory
  now?: number
}): Pick<ClearSignUnsignedArtifact, 'version' | 'format' | 'payloadHex' | 'payloadHash' | 'digestAlgorithm' | 'signatureAlgorithm' | 'keyId'> {
  const payload = buildEvmSchemaBody(compileApprovedErc20TokenSchema(input))
  return {
    version: 1, format: 'evm-v2-certified-inner', payloadHex: payload.toString('hex'),
    payloadHash: createHash('sha256').update(Uint8Array.from(payload)).digest('hex'),
    digestAlgorithm: 'sha256', signatureAlgorithm: 'secp256k1-compact', keyId: CERTIFIED_DELEGATE_KEY_ID,
  }
}

/** Promotion evaluation and compilation are pure. This function has no key access and cannot publish. */
export function compilePromotedClearSignArtifact(input: {
  bundle: ClearSignPromotionBundle
  reviews: ClearSignPromotionReview[]
  currentEvidence: ClearSignAuditEvidence
  observedShape: Record<string, unknown>
  revoked?: boolean
  now?: number
}): ClearSignUnsignedArtifact {
  if (input.revoked) throw new Error('PROMOTION_NOT_PUBLISHABLE:BUNDLE_REVOKED')
  const verdict = evaluateClearSignPromotion({
    bundle: input.bundle, reviews: input.reviews, currentEvidence: input.currentEvidence,
    now: input.now,
  })
  if (!verdict.publishable) throw new Error(`PROMOTION_NOT_PUBLISHABLE:${verdict.failures.join(',')}`)
  const payload = input.bundle.chain === 'Ethereum'
    ? compileUnsignedEvmV2Body(input.bundle, input.observedShape)
    : compileUnsignedSolanaSchema(input.bundle, input.observedShape)
  return {
    version: 1, bundleHash: verdict.bundleHash, shapeKey: input.bundle.shapeKey,
    identityHash: input.bundle.identityHash, expiresAt: input.bundle.expiresAt,
    format: input.bundle.chain === 'Ethereum' ? 'evm-v2-certified-inner' : 'solana-kksolsc1',
    payloadHex: payload.toString('hex'), payloadHash: createHash('sha256').update(Uint8Array.from(payload)).digest('hex'),
    digestAlgorithm: 'sha256', signatureAlgorithm: 'secp256k1-compact', keyId: CERTIFIED_DELEGATE_KEY_ID,
    reviewerFingerprints: verdict.reviewerFingerprints,
  }
}
