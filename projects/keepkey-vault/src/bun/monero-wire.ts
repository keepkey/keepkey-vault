/** Monero device wire encoding and the checks around research signing. Pure: no device, process or network I/O. */
import { keccak_256 } from '@noble/hashes/sha3'
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import type { MoneroOutputRecord, MoneroPlan } from '../../monero-cli/src/protocol'

export class MoneroError extends Error {}
export const MAX_UINT64 = 18446744073709551615n
export const MONERO_PATH = [0x8000002c, 0x80000080, 0x80000000]
export const MAX_SIGNED_RESPONSE = 16384 + 64

type Fields = Map<number, Array<bigint | Uint8Array>>

export function varint(value: bigint): Uint8Array {
  const bytes: number[] = []
  do { const next = Number(value & 127n); value >>= 7n; bytes.push(next | (value ? 128 : 0)) } while (value)
  return new Uint8Array(bytes)
}
export function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
export function numberField(field: number, value: number | bigint): Uint8Array { return concat([varint(BigInt(field << 3)), varint(BigInt(value))]) }
export function lengthField(field: number, value: Uint8Array): Uint8Array { return concat([varint(BigInt((field << 3) | 2)), varint(BigInt(value.length)), value]) }
export function parseFields(body: Uint8Array): Fields {
  let offset = 0
  const result: Fields = new Map()
  const nextNumber = (): bigint => {
    let value = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= body.length) throw new MoneroError('Invalid Monero device response')
      const byte = body[offset++]; value |= BigInt(byte & 127) << shift
      if (!(byte & 128)) {
        if (value > MAX_UINT64) throw new MoneroError('Invalid Monero device response')
        return value
      }
    }
    throw new MoneroError('Invalid Monero device response')
  }
  while (offset < body.length) {
    const tag = nextNumber(), field = Number(tag >> 3n), encoding = Number(tag & 7n)
    if (!Number.isSafeInteger(field) || field < 1) throw new MoneroError('Invalid Monero device response')
    let value: bigint | Uint8Array
    if (encoding === 0) value = nextNumber()
    else if (encoding === 2) {
      const length = nextNumber()
      if (length > BigInt(body.length - offset)) throw new MoneroError('Invalid Monero device response')
      value = body.subarray(offset, offset + Number(length)); offset += Number(length)
    } else throw new MoneroError('Invalid Monero device response')
    const values = result.get(field) ?? []; values.push(value); result.set(field, values)
  }
  return result
}
export function bytesField(fields: Fields, field: number): Uint8Array {
  const values = fields.get(field)
  if (values?.length !== 1 || !(values[0] instanceof Uint8Array)) throw new MoneroError('Invalid Monero device response')
  return values[0]
}

const unhex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')

// ── Key-image sync (530..535) ──

/** MoneroTransferDetails with explicit subaddress indices, so no subaddress table is needed. */
export function transferDetails(output: MoneroOutputRecord): Uint8Array {
  return concat([lengthField(1, unhex(output.outKey)), lengthField(2, unhex(output.txPublicKey)),
    ...output.additionalTxPublicKeys.map(key => lengthField(3, unhex(key))), numberField(4, output.outputIndex),
    numberField(5, output.subaddressMajor), numberField(6, output.subaddressMinor)])
}

/** The firmware's transcript: Keccak over Keccak(out_key || tx_pub || additional... || varint(index)) per output. */
export function keyImageInitRequest(outputs: MoneroOutputRecord[]): Uint8Array {
  const hashes = outputs.map(output => keccak_256(concat([unhex(output.outKey), unhex(output.txPublicKey),
    ...output.additionalTxPublicKeys.map(unhex), varint(BigInt(output.outputIndex))])))
  return concat([numberField(1, outputs.length), lengthField(2, keccak_256(concat(hashes))),
    ...MONERO_PATH.map(part => numberField(3, part)), numberField(4, 0)])
}

/** ChaCha20-Poly1305 (IETF) record: key image || ring signature. */
export function openKeyImage(key: Uint8Array, iv: Uint8Array, blob: Uint8Array): { keyImage: string; signature: string } {
  if (key.length !== 32 || iv.length !== 12 || blob.length !== 112) throw new MoneroError('Invalid Monero key-image record')
  let plain: Uint8Array
  try { plain = chacha20poly1305(key, iv).decrypt(blob) } catch { throw new MoneroError('A Monero key-image record failed authentication') }
  try { return { keyImage: hex(plain.subarray(0, 32)), signature: hex(plain.subarray(32, 96)) } } finally { plain.fill(0) }
}

// ── Research signing (65000/65001) ──

export function signRequest(plan: MoneroPlan): Uint8Array {
  const source = (input: MoneroPlan['inputs'][number]) => concat([numberField(1, BigInt(input.amountAtomic)), numberField(2, input.realMember),
    numberField(3, input.outputIndex), numberField(4, input.subaddressMajor), numberField(5, input.subaddressMinor),
    lengthField(6, unhex(input.txPublicKey)), lengthField(7, unhex(input.mask)),
    ...input.ring.map(member => lengthField(8, concat([numberField(1, BigInt(member.globalIndex)),
      lengthField(2, unhex(member.publicKey)), lengthField(3, unhex(member.commitment))]))),
    ...input.additionalTxPublicKeys.map(key => lengthField(9, unhex(key)))])
  const output = (item: MoneroPlan['outputs'][number]) => concat([numberField(1, BigInt(item.amountAtomic)),
    lengthField(2, new TextEncoder().encode(item.address)), numberField(3, item.isChange ? 1 : 0),
    ...(item.isChange ? [numberField(4, item.changeMajor), numberField(5, item.changeMinor)] : [])])
  return concat([...MONERO_PATH.map(part => numberField(1, part)), numberField(2, plan.network), numberField(3, BigInt(plan.feeAtomic)),
    ...plan.inputs.map(input => lengthField(4, source(input))), ...plan.outputs.map(item => lengthField(5, output(item))), numberField(6, 0)])
}

export interface MoneroSendReview {
  recipient: string
  amountAtomic: string
  feeAtomic: string
  changeAtomic: string
  totalAtomic: string
  inputCount: number
  /** In device review order. */
  outputs: Array<{ role: 'recipient' | 'change'; address: string; amountAtomic: string }>
}

/** Refuse any plan that is not exactly the user's payment plus change back to this wallet, from synced owned outputs. */
export function reviewPlan(plan: MoneroPlan, intent: {
  address: string; amountAtomic: string; walletAddress: string; walletFeeAtomic: string; walletAmountAtomic: string
  owned: Map<string, { amountAtomic: string; keyImage: string }>
}): MoneroSendReview {
  const fail = (why: string) => { throw new MoneroError(`The prepared Monero transaction does not match your request: ${why}`) }
  if (plan.network !== 0) fail('network')
  const recipients = plan.outputs.filter(output => !output.isChange), change = plan.outputs.filter(output => output.isChange)
  if (recipients.length !== 1 || recipients[0].address !== intent.address) fail('recipient')
  if (recipients[0].amountAtomic !== intent.amountAtomic || intent.walletAmountAtomic !== intent.amountAtomic) fail('amount')
  if (change.length > 1 || change.some(output => output.address !== intent.walletAddress || output.changeMajor || output.changeMinor)) fail('change')
  if (plan.feeAtomic !== intent.walletFeeAtomic || BigInt(plan.feeAtomic) <= 0n) fail('fee')
  const seen = new Set<string>()
  let inputTotal = 0n
  for (const input of plan.inputs) {
    const real = input.ring[input.realMember]?.publicKey, owned = real ? intent.owned.get(real) : undefined
    if (!owned || seen.has(real) || owned.amountAtomic !== input.amountAtomic) fail('input')
    seen.add(real); inputTotal += BigInt(input.amountAtomic)
  }
  const outputTotal = plan.outputs.reduce((total, output) => total + BigInt(output.amountAtomic), 0n)
  if (inputTotal !== outputTotal + BigInt(plan.feeAtomic)) fail('totals')
  return { recipient: intent.address, amountAtomic: intent.amountAtomic, feeAtomic: plan.feeAtomic,
    changeAtomic: (change[0]?.amountAtomic ?? '0'), totalAtomic: (BigInt(intent.amountAtomic) + BigInt(plan.feeAtomic)).toString(),
    inputCount: plan.inputs.length,
    outputs: plan.outputs.map(output => ({ role: output.isChange ? 'change' : 'recipient', address: output.address, amountAtomic: output.amountAtomic })) }
}

export interface ParsedMoneroTransaction {
  hash: string
  fee: bigint
  outputCount: number
  inputs: Array<{ indices: bigint[]; keyImage: string }>
}

/** Bounded RingCT v2 / CLSAG / Bulletproof+ layout, same shape the firmware research tree checks. */
export function parseSignedTransaction(blob: Uint8Array): ParsedMoneroTransaction {
  let offset = 0
  const bad = (): never => { throw new MoneroError('The KeepKey returned an invalid Monero transaction') }
  const number = (): bigint => {
    let value = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= blob.length) bad()
      const byte = blob[offset++]; value |= BigInt(byte & 127) << shift
      if (!(byte & 128)) return value > MAX_UINT64 ? bad() : value
    }
    return bad()
  }
  const small = (max: number) => { const value = number(); return value > BigInt(max) ? bad() : Number(value) }
  const take = (count: number) => { if (count < 0 || offset + count > blob.length) bad(); offset += count; return blob.subarray(offset - count, offset) }
  if (blob.length < 1 || blob.length > 16384 || number() !== 2n || number() !== 0n) bad()
  const inputCount = small(4)
  if (inputCount < 1) bad()
  const inputs = []
  for (let i = 0; i < inputCount; i++) {
    if (take(1)[0] !== 2 || number() !== 0n || number() !== 16n) bad()
    const indices: bigint[] = []
    let index = 0n
    for (let j = 0; j < 16; j++) { index += number(); if (index > MAX_UINT64) bad(); indices.push(index) }
    inputs.push({ indices, keyImage: hex(take(32)) })
  }
  const outputCount = small(4)
  if (outputCount < 2) bad()
  for (let i = 0; i < outputCount; i++) { if (number() !== 0n || take(1)[0] !== 3) bad(); take(33) }
  take(small(1060))
  const prefixEnd = offset
  if (take(1)[0] !== 6) bad()
  const fee = number()
  take(outputCount * 40)
  const baseEnd = offset
  const proofs = small(outputCount)
  if (proofs < 1) bad()
  for (let i = 0; i < proofs; i++) {
    take(6 * 32)
    const rounds = small(8)
    if (rounds < 6) bad()
    take(rounds * 32)
    if (small(8) !== rounds) bad()
    take(rounds * 32)
  }
  take(inputCount * 18 * 32 + inputCount * 32)
  if (offset !== blob.length) bad()
  const hash = keccak_256(concat([keccak_256(blob.subarray(0, prefixEnd)), keccak_256(blob.subarray(prefixEnd, baseEnd)), keccak_256(blob.subarray(baseEnd))]))
  return { hash: hex(hash), fee, outputCount, inputs }
}

/** The signed bytes must spend exactly the reviewed inputs, with the reviewed rings, outputs and fee. */
export function checkSignedTransaction(parsed: ParsedMoneroTransaction, returnedHash: string, plan: MoneroPlan,
  owned: Map<string, { amountAtomic: string; keyImage: string }>): void {
  const fail = () => { throw new MoneroError('The signed Monero transaction does not match the reviewed plan; it was not sent') }
  if (parsed.hash !== returnedHash || parsed.fee !== BigInt(plan.feeAtomic) || parsed.outputCount !== plan.outputs.length ||
      parsed.inputs.length !== plan.inputs.length) fail()
  const expected = new Map(plan.inputs.map(input => [owned.get(input.ring[input.realMember].publicKey)?.keyImage, input]))
  for (const input of parsed.inputs) {
    const source = expected.get(input.keyImage)
    if (!source || source.ring.some((member, i) => BigInt(member.globalIndex) !== input.indices[i])) fail()
    expected.delete(input.keyImage)
  }
  if (expected.size) fail()
}
