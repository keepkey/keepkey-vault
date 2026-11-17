/** Independently bind streamed outputs to the reviewed destination, amount and change.
 * Core verifies CLSAG/Bulletproof+ and rings; those proofs alone do not establish
 * which addresses the transaction pays. Final's payment keys let us reconstruct
 * each output without a private spend key or any network request. */
import { ed25519 } from '@noble/curves/ed25519'
import { keccak_256 } from '@noble/hashes/sha3'
import type { MoneroPlan } from '../../monero-cli/src/protocol'
import { moneroDestinationAddressKeys } from '../shared/monero-address'
import { MoneroError, concat, varint, type ParsedMoneroTransaction } from './monero-wire'
import { verifyMoneroTransactionKeys, type MoneroTransactionKeys } from './monero-transaction-keys'

const L = (1n << 252n) + 27742317777372353535851937790883648493n
const H = ed25519.ExtendedPoint.fromHex('8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94')
const scalar = (bytes: Uint8Array) => bytes.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n)
const canonical = (bytes: Uint8Array) => bytes.length === 32 && scalar(bytes) > 0n && scalar(bytes) < L
const encodedScalar = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number(n >> BigInt(i * 8) & 255n))
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
const text = (value: string) => new TextEncoder().encode(value)
const hs = (value: Uint8Array) => scalar(keccak_256(value)) % L
type Point = ReturnType<typeof ed25519.ExtendedPoint.fromHex>
const multiply = (point: Point, value: bigint) => value === 0n ? ed25519.ExtendedPoint.ZERO : point.multiply(value)

export const STREAM_OUTPUT_BINDING_ERROR = 'The signed Monero outputs do not match the approved recipient, amount and change. Nothing was sent.'
export const STREAM_MONITORING_KEY_ERROR = 'Reconnect Monero monitoring to authorize subaddress change derivation'

function destinations(plan: MoneroPlan) {
  const entries = plan.outputs.map(output => {
    const keys = moneroDestinationAddressKeys(output.address)
    if (!keys) throw new MoneroError(STREAM_OUTPUT_BINDING_ERROR)
    point(keys.spend); point(keys.view)
    return keys
  })
  const recipients = [...new Map(plan.outputs.filter(o => !o.isChange).map(o => [o.address, o])).values()]
  const subaddresses = recipients.filter(o => moneroDestinationAddressKeys(o.address)!.kind === 'subaddress')
  return { entries, singleSubaddress: subaddresses.length === 1 && recipients.length === 1,
    needAdditional: subaddresses.length > 0 && (recipients.length > subaddresses.length || subaddresses.length > 1) }
}

function point(bytes: Uint8Array): Point {
  const decoded = ed25519.ExtendedPoint.fromHex(bytes, false)
  if (decoded.isSmallOrder() || !decoded.isTorsionFree()) throw new MoneroError(STREAM_OUTPUT_BINDING_ERROR)
  return decoded
}

/** Ordinary change to a standard address has a*rG = r*A, so no monitoring key
 * is needed. A sole subaddress recipient uses R=rD and requires approved a*R. */
export function streamNeedsMonitoringKey(plan: MoneroPlan): boolean {
  const info = destinations(plan)
  return plan.outputs.some((o, i) => o.isChange && (info.singleSubaddress || info.entries[i].kind === 'subaddress'))
}

/** Call before Init, so absent/mismatched monitoring consent never leaves a
 * half-signed transaction or causes a pointless device approval. */
export function validateStreamMonitoringKey(plan: MoneroPlan, key?: Uint8Array | null,
  translate: (source: string) => string = s => s): void {
  if (!streamNeedsMonitoringKey(plan)) return
  const fail = (): never => { throw new MoneroError(translate(STREAM_MONITORING_KEY_ERROR)) }
  if (!key || !canonical(key)) fail()
  const change = plan.outputs.find(o => o.isChange)!
  const keys = moneroDestinationAddressKeys(change.address)!
  try {
    const base = keys.kind === 'subaddress' ? point(keys.spend) : ed25519.ExtendedPoint.BASE
    if (!equal(base.multiply(scalar(key!)).toRawBytes(), keys.view)) fail()
  } catch { fail() }
}

export function verifyStreamOutputBindings(plan: MoneroPlan, parsed: ParsedMoneroTransaction, txKey: Uint8Array,
  additional: Uint8Array[], senderViewKey?: Uint8Array | null,
  translate: (source: string) => string = s => s): MoneroTransactionKeys {
  const fail = (): never => { throw new MoneroError(translate(STREAM_OUTPUT_BINDING_ERROR)) }
  validateStreamMonitoringKey(plan, senderViewKey, translate)
  const info = destinations(plan)
  if (!canonical(txKey) || additional.length !== (info.needAdditional ? plan.outputs.length : 0) || additional.some(k => !canonical(k))) fail()
  if (parsed.outputData.length !== plan.outputs.length * 35 || parsed.encryptedAmounts.length !== plan.outputs.length * 8
    || parsed.commitments.length !== plan.outputs.length * 32) fail()
  try {
    const primary = point(parsed.extra.subarray(1, 33))
    for (const [index, output] of plan.outputs.entries()) {
      const destination = info.entries[index]
      const spend = point(destination.spend), view = point(destination.view)
      const needsView = output.isChange && (info.singleSubaddress || destination.kind === 'subaddress')
      const derivation = needsView
        ? primary.multiply(scalar(senderViewKey!)).multiply(8n).toRawBytes()
        : view.multiply(scalar(destination.kind === 'subaddress' && info.needAdditional ? additional[index] : txKey)).multiply(8n).toRawBytes()
      const indexed = concat([derivation, varint(BigInt(index))])
      const shared = encodedScalar(hs(indexed))
      const amountHash = keccak_256(concat([text('amount'), shared]))
      const maskInput = concat([text('commitment_mask'), shared])
      const mask = encodedScalar(hs(maskInput))
      try {
        const actualOutput = parsed.outputData.subarray(index * 35, (index + 1) * 35)
        const expectedKey = multiply(ed25519.ExtendedPoint.BASE, scalar(shared)).add(spend).toRawBytes()
        const tag = keccak_256(concat([text('view_tag'), indexed]))[0]
        if (actualOutput[0] !== 0 || actualOutput[1] !== 3 || !equal(actualOutput.subarray(2, 34), expectedKey) || actualOutput[34] !== tag) fail()
        const encodedAmount = parsed.encryptedAmounts.subarray(index * 8, (index + 1) * 8)
        const amount = BigInt(output.amountAtomic)
        for (let i = 0; i < 8; i++) if ((encodedAmount[i] ^ amountHash[i]) !== Number(amount >> BigInt(i * 8) & 255n)) fail()
        const commitment = multiply(ed25519.ExtendedPoint.BASE, scalar(mask)).add(multiply(H, amount)).toRawBytes()
        if (!equal(commitment, parsed.commitments.subarray(index * 32, (index + 1) * 32))) fail()
      } finally {
        derivation.fill(0); indexed.fill(0); shared.fill(0); amountHash.fill(0); maskInput.fill(0); mask.fill(0)
      }
    }
    // Convert payment secrets to persistent strings only after all output checks.
    return verifyMoneroTransactionKeys(plan, parsed.extra, txKey, additional, translate)
  } catch { return fail() }
}
