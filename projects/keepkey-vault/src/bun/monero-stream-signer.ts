/** Firmware messages-monero.proto, 1800..1825. Only public transaction pieces and session MACs leave the device. */
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { keccak_256 } from '@noble/hashes/sha3'
import type { MoneroPlan } from '../../monero-cli/src/protocol'
import { moneroDestinationAddressKeys } from '../shared/monero-address'
import { MoneroError, MONERO_PATH, MAX_UINT64, bytesField, concat, lengthField, numberField, parseFields, parseSignedTransaction, varint } from './monero-wire'

export { CAPABILITY_MONERO_SIGNING, supportsMoneroSigning } from '../shared/monero-capability'
export type MoneroSigningPhase = 'review' | 'inputs' | 'outputs' | 'proving' | 'signing' | 'verifying'
export type MoneroText = (source: string) => string
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
const unhex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
const empty = () => new Uint8Array()

export const STREAM_ERRORS = {
  outputs: 'Monero signing requires exactly two outputs: one recipient and one change output.',
  ring: 'Monero signing requires a ring size of 16 for every input.',
  plan: 'This Monero plan is outside the supported signing limits. Nothing was signed.',
  response: 'The KeepKey returned invalid streamed Monero signing data. Nothing was sent.',
  prefix: 'The assembled Monero prefix hash differs from the device. Nothing was sent.',
  authentication: 'A Monero signature failed authentication. Nothing was sent.',
  verifier: 'The pinned Monero Core verifier is unavailable in this build. Nothing was signed.',
  verification: 'The Monero transaction failed independent Core verification. Nothing was sent.',
} as const

/** Check before Init. Desktop retains its adapter/parser/pinned Core ABI limit of four inputs (firmware supports 64). */
export function checkStreamSigningBounds(plan: MoneroPlan, text: MoneroText = s => s): void {
  const fail = () => { throw new MoneroError(text(STREAM_ERRORS.plan)) }
  if (plan.outputs.length !== 2 || plan.outputs.filter(o => o.isChange).length !== 1) throw new MoneroError(text(STREAM_ERRORS.outputs))
  if (plan.inputs.some(i => i.ring.length !== 16)) throw new MoneroError(text(STREAM_ERRORS.ring))
  if (plan.network !== 0 || plan.inputs.length < 1 || plan.inputs.length > 4) fail()
  const u32 = (v: number) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
  const atomic = (v: string) => /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= MAX_UINT64
  const key = (v: string) => /^[0-9a-f]{64}$/.test(v)
  const change = plan.outputs.find(o => o.isChange)!
  if (!u32(change.changeMajor) || change.changeMinor !== 0 || !atomic(plan.feeAtomic)) fail()
  let totalIn = 0n, totalOut = 0n
  const realKeys = new Set<string>()
  for (const i of plan.inputs) {
    if (!u32(i.realMember) || i.realMember >= 16 || !u32(i.outputIndex) || !u32(i.subaddressMajor) || !u32(i.subaddressMinor) ||
        i.subaddressMajor !== change.changeMajor || !atomic(i.amountAtomic) || !key(i.txPublicKey) || !key(i.mask) ||
        i.additionalTxPublicKeys.length > 16 || i.additionalTxPublicKeys.some(k => !key(k)) ||
        (i.additionalTxPublicKeys.length > 0 && i.outputIndex >= i.additionalTxPublicKeys.length)) fail()
    let previous = -1n
    for (const r of i.ring) {
      if (!atomic(r.globalIndex) || BigInt(r.globalIndex) <= previous || !key(r.publicKey) || !key(r.commitment)) fail()
      previous = BigInt(r.globalIndex)
    }
    const real = i.ring[i.realMember].publicKey
    if (realKeys.has(real)) fail()
    realKeys.add(real); totalIn += BigInt(i.amountAtomic)
  }
  for (const o of plan.outputs) {
    if (!atomic(o.amountAtomic) || !moneroDestinationAddressKeys(o.address)) fail()
    totalOut += BigInt(o.amountAtomic)
  }
  if (plan.outputs[0].address === plan.outputs[1].address || totalIn > MAX_UINT64 || totalOut > MAX_UINT64 || totalIn !== totalOut + BigInt(plan.feeAtomic)) fail()
}

export function streamDestination(output: MoneroPlan['outputs'][number]): Uint8Array {
  const keys = moneroDestinationAddressKeys(output.address)!
  return concat([numberField(1, BigInt(output.amountAtomic)), lengthField(2, keys.spend), lengthField(3, keys.view),
    numberField(4, Number(keys.kind === 'subaddress')), numberField(5, 0)])
}

export function streamSource(input: MoneroPlan['inputs'][number]): Uint8Array {
  return concat([...input.ring.map(r => lengthField(1, concat([numberField(1, BigInt(r.globalIndex)), lengthField(2, unhex(r.publicKey)), lengthField(3, unhex(r.commitment))]))),
    numberField(2, input.realMember), lengthField(3, unhex(input.txPublicKey)),
    ...(input.additionalTxPublicKeys.length ? [lengthField(4, unhex(input.additionalTxPublicKeys[input.outputIndex]))] : []),
    numberField(5, input.outputIndex), numberField(6, BigInt(input.amountAtomic)), lengthField(7, unhex(input.mask)),
    numberField(8, input.subaddressMajor), numberField(9, input.subaddressMinor)])
}

export function streamInitRequest(plan: MoneroPlan, text?: MoneroText): Uint8Array {
  checkStreamSigningBounds(plan, text)
  const change = plan.outputs.find(o => o.isChange)!, keys = moneroDestinationAddressKeys(change.address)!
  const data = concat([...plan.outputs.map(o => lengthField(1, streamDestination(o))),
    lengthField(2, concat([numberField(1, BigInt(change.amountAtomic)), lengthField(2, keys.spend), lengthField(3, keys.view),
      numberField(4, change.changeMajor), numberField(5, 0)])),
    numberField(3, plan.inputs.length), numberField(4, 16), numberField(5, BigInt(plan.feeAtomic)), numberField(6, change.changeMajor),
    numberField(8, 0), numberField(9, 16), numberField(10, 4)])
  return concat([...MONERO_PATH.map(p => numberField(1, p)), numberField(2, plan.network), lengthField(3, data)])
}

type InputAck = { origIdx: number; vini: Uint8Array; hmac: Uint8Array; pseudoOut: Uint8Array; pseudoHmac: Uint8Array }
type OutputAck = { txOut: Uint8Array; outPk: Uint8Array; ecdh: Uint8Array; proof?: Uint8Array }
type SignAck = { encrypted: Uint8Array; pseudoOut: Uint8Array }
type AllOutAck = { extra: Uint8Array; prefixHash: Uint8Array; fee: bigint; rctType: bigint; message: Uint8Array }

/** Matches Flow::prefix / Flow::assemble in firmware/unittests/firmware/monero_tx.cpp. */
export function assembleStreamTransaction(inputs: InputAck[], outputs: OutputAck[], all: AllOutAck, signs: SignAck[], openingKey: Uint8Array,
  text: MoneroText = s => s): { blob: Uint8Array; hash: string; prefixHash: string } {
  const bad = () => { throw new MoneroError(text(STREAM_ERRORS.response)) }
  if (openingKey.length !== 32 || inputs.length < 1 || signs.length !== inputs.length || outputs.length !== 2 || all.rctType !== 6n ||
      outputs[0].proof || outputs[1].proof?.length !== 642 || all.prefixHash.length !== 32) bad()
  const prefix = concat([varint(2n), varint(0n), varint(BigInt(inputs.length)), ...inputs.map(i => i.vini), varint(2n),
    ...outputs.map(o => o.txOut), varint(BigInt(all.extra.length)), all.extra])
  const prefixHash = keccak_256(prefix)
  if (!same(prefixHash, all.prefixHash)) throw new MoneroError(text(STREAM_ERRORS.prefix))
  const base = concat([new Uint8Array([6]), varint(all.fee), ...outputs.map(o => o.ecdh), ...outputs.map(o => o.outPk.subarray(32))])
  const plain: Uint8Array[] = []
  try {
    for (const [position, sign] of signs.entries()) {
      if (sign.encrypted.length !== 592 || sign.pseudoOut.length !== 32) bad()
      const nonce = new Uint8Array(12)
      new DataView(nonce.buffer).setUint32(0, position, true)
      try { plain.push(chacha20poly1305(openingKey, nonce).decrypt(sign.encrypted)) }
      catch { throw new MoneroError(text(STREAM_ERRORS.authentication)) }
    }
    const blob = concat([prefix, base, varint(1n), outputs[1].proof!, ...plain, ...signs.map(s => s.pseudoOut)])
    const parsed = parseSignedTransaction(blob)
    return { blob, hash: parsed.hash, prefixHash: hex(prefixHash) }
  } finally { plain.forEach(p => p.fill(0)) }
}

/** The caller holds one transport lock across the entire flow and handles ButtonRequest/Failure/cancellation. No step is retried. */
export async function signMoneroStream(plan: MoneroPlan, exchange: (request: number, response: number, payload: Uint8Array, review: boolean) => Promise<Uint8Array>,
  options: { onProgress?: (phase: MoneroSigningPhase) => void; text?: MoneroText } = {}): Promise<{ blob: Uint8Array; hash: string; prefixHash: string }> {
  const text = options.text ?? (s => s)
  const init = streamInitRequest(plan, text) // refuse unsupported plans before any device I/O
  const bad = (): never => { throw new MoneroError(text(STREAM_ERRORS.response)) }
  const request = async (id: number, payload: Uint8Array = empty(), review = false) => {
    const body = await exchange(id, id + 1, payload, review)
    try {
      const fields = parseFields(body)
      // Copies own their lifetime; the opening key is scrubbed below.
      return new Map([...fields].map(([k, values]) => [k, values.map(v => v instanceof Uint8Array ? v.slice() : v)]))
    } finally { body.fill(0) }
  }
  const bytes = (fields: ReturnType<typeof parseFields>, n: number, length?: number) => {
    const b = bytesField(fields, n)
    if (length !== undefined && b.length !== length) bad()
    return b
  }
  const num = (fields: ReturnType<typeof parseFields>, n: number) => {
    const v = fields.get(n)
    if (v?.length !== 1 || typeof v[0] !== 'bigint') return bad()
    return v[0]
  }
  const ackEmpty = async (id: number, payload: Uint8Array = empty()) => { if ((await request(id, payload)).size) bad() }
  const progress = (phase: MoneroSigningPhase) => options.onProgress?.(phase)
  progress('review')
  const start = await request(1810, init, true), macs = start.get(1)
  if (start.size !== 2 || num(start, 2) !== 0n || macs?.length !== 2 || macs.some(m => !(m instanceof Uint8Array) || m.length !== 32)) bad()
  const inputs: InputAck[] = [], outputs: OutputAck[] = [], signs: SignAck[] = []
  progress('inputs')
  for (const [origIdx, input] of plan.inputs.entries()) {
    const f = await request(1812, lengthField(1, streamSource(input)))
    if (f.size !== 4) bad()
    const vini = bytes(f, 1)
    // Compare the whole input encoding except the device's key image against the reviewed ring.
    let previous = 0n
    const expected = concat([new Uint8Array([2, 0, 16]), ...input.ring.map(r => { const index = BigInt(r.globalIndex), delta = index - previous; previous = index; return varint(delta) })])
    if (vini.length !== expected.length + 32 || !same(vini.subarray(0, -32), expected)) bad()
    inputs.push({ origIdx, vini, hmac: bytes(f, 2, 32), pseudoOut: bytes(f, 3, 32), pseudoHmac: bytes(f, 4, 32) })
  }
  inputs.sort((a, b) => Buffer.compare(b.vini.subarray(-32), a.vini.subarray(-32)))
  for (let i = 1; i < inputs.length; i++) if (same(inputs[i - 1].vini.subarray(-32), inputs[i].vini.subarray(-32))) bad()
  for (const input of inputs) await ackEmpty(1814, concat([lengthField(1, input.vini), lengthField(2, input.hmac), numberField(3, input.origIdx)]))
  await ackEmpty(1816)
  for (const [index, output] of plan.outputs.entries()) {
    progress(index === 1 ? 'proving' : 'outputs')
    const f = await request(1818, concat([lengthField(1, streamDestination(output)), lengthField(2, macs![index] as Uint8Array)]))
    if (f.size !== (index === 1 ? 4 : 3)) bad()
    const txOut = bytes(f, 1, 35), outPk = bytes(f, 2, 64)
    if (txOut[0] !== 0 || txOut[1] !== 3 || !same(txOut.subarray(2, 34), outPk.subarray(0, 32))) bad()
    outputs.push({ txOut, outPk, ecdh: bytes(f, 3, 8), ...(index === 1 ? { proof: bytes(f, 4, 642) } : {}) })
  }
  const f = await request(1820)
  if (f.size !== 5) bad()
  const all = { extra: bytes(f, 1), prefixHash: bytes(f, 2, 32), fee: num(f, 3), rctType: num(f, 4), message: bytes(f, 5, 32) }
  if (all.extra.length !== 44 || all.extra[0] !== 1 || all.extra[33] !== 2 || all.extra[34] !== 9 || all.extra[35] !== 1 ||
      all.fee !== BigInt(plan.feeAtomic) || all.rctType !== 6n) bad()
  // Check the prefix before requesting signatures, and again on the assembled blob before relay.
  const prefix = concat([varint(2n), varint(0n), varint(BigInt(inputs.length)), ...inputs.map(i => i.vini), varint(2n), ...outputs.map(o => o.txOut), varint(BigInt(all.extra.length)), all.extra])
  if (!same(keccak_256(prefix), all.prefixHash)) throw new MoneroError(text(STREAM_ERRORS.prefix))
  progress('signing')
  for (const input of inputs) {
    const f = await request(1822, concat([lengthField(1, streamSource(plan.inputs[input.origIdx])), lengthField(2, input.vini),
      lengthField(3, input.hmac), lengthField(4, input.pseudoOut), lengthField(5, input.pseudoHmac), numberField(6, input.origIdx)]))
    if (f.size !== 2) bad()
    signs.push({ encrypted: bytes(f, 1, 592), pseudoOut: bytes(f, 2, 32) })
  }
  const final = await request(1824)
  try {
    if (final.size !== 1) bad()
    const key = bytes(final, 1, 32)
    progress('verifying')
    return assembleStreamTransaction(inputs, outputs, all, signs, key, text)
  } finally { for (const values of final.values()) for (const value of values) if (value instanceof Uint8Array) value.fill(0) }
}
