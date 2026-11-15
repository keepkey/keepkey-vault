import { expect, test } from 'bun:test'
import { keccak_256 } from '@noble/hashes/sha3'
import { readFileSync } from 'node:fs'
import type { MoneroPlan } from '../../monero-cli/src/protocol'
import { bytesField, concat, lengthField, numberField, parseFields, parseSignedTransaction } from './monero-wire'
import { checkStreamSigningBounds, signMoneroStream, streamDestination, streamInitRequest, streamSource, supportsMoneroSigning, STREAM_ERRORS, type MoneroSigningPhase } from './monero-stream-signer'
import { coreNativePlan, createMoneroCoreVerifier } from './monero-device-signing'

const fixtures = JSON.parse(readFileSync(new URL('./monero-stream.fixtures.json', import.meta.url), 'utf8'))
const cases = fixtures.cases as Array<{ name: string; plan: MoneroPlan; requests: Array<{ id: number; hex: string }>; responses: Array<{ id: number; hex: string }>; transactionHex: string; prefixHash: string; transactionKeccak: string }>
const unhex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')

/** Replay public vector envelopes; no emulator, USB delegate, daemon or balances. */
function replay(c = cases[0], mutate?: (id: number, body: Uint8Array) => Uint8Array) {
  let position = 0
  const ids: number[] = [], consumed: Uint8Array[] = []
  const exchange = async (request: number, response: number, payload: Uint8Array, review: boolean) => {
    ids.push(request)
    expect({ id: request, hex: hex(payload) }).toEqual(c.requests[position])
    expect(response).toBe(c.responses[position].id)
    expect(review).toBe(request === 1810)
    let body: Uint8Array = unhex(c.responses[position++].hex)
    if (mutate) body = mutate(response, body)
    consumed.push(body)
    return body
  }
  return { exchange, ids, consumed }
}

test('capability 31 alone selects streamed signing', () => {
  expect(supportsMoneroSigning()).toBe(false)
  expect(supportsMoneroSigning([])).toBe(false)
  expect(supportsMoneroSigning([30, 32])).toBe(false)
  expect(supportsMoneroSigning([31])).toBe(true)
})

test('Init, source and destination bytes equal independent protoc fixtures', () => {
  for (const c of cases) {
    expect(hex(streamInitRequest(c.plan))).toBe(c.requests[0].hex)
    expect(c.plan.inputs.map(i => hex(lengthField(1, streamSource(i))))).toEqual(c.requests.filter(r => r.id === 1812).map(r => r.hex))
    const requests = c.requests.filter(r => r.id === 1818)
    for (const [index, output] of c.plan.outputs.entries()) expect(streamDestination(output)).toEqual(bytesField(parseFields(unhex(requests[index].hex)), 1))
  }
})

test('assembly exactly reproduces the one- and two-input transactions accepted by Core v0.18.5.4', async () => {
  for (const c of cases) {
    const r = replay(c), phases: MoneroSigningPhase[] = []
    const signed = await signMoneroStream(c.plan, r.exchange, { onProgress: phase => phases.push(phase) })
    expect(hex(signed.blob)).toBe(c.transactionHex)
    expect(hex(keccak_256(signed.blob))).toBe(c.transactionKeccak) // committed firmware header digest, not txid
    expect(signed.prefixHash).toBe(c.prefixHash)
    expect(parseSignedTransaction(signed.blob).prefixHash).toBe(c.prefixHash)
    expect(r.ids).toEqual(c.requests.map(r => r.id))
    expect(phases).toEqual(['review', 'inputs', 'outputs', 'proving', 'signing', 'verifying'])
    expect(r.consumed.every(b => b.every(v => v === 0))).toBe(true)
  }
})

test('vini and signatures use decreasing key images even when plan order is reversed', async () => {
  const c = structuredClone(cases[1])
  c.plan.inputs.reverse()
  // The tokens stay attached to their inputs; only the host's plan indices change.
  const inputSlots = c.requests.flatMap((r, i) => r.id === 1812 ? [i] : [])
  const a = inputSlots[0], b = inputSlots[1]
  ;[c.requests[a], c.requests[b]] = [c.requests[b], c.requests[a]]
  ;[c.responses[a], c.responses[b]] = [c.responses[b], c.responses[a]]
  for (const request of c.requests.filter(r => r.id === 1814 || r.id === 1822)) {
    const field = request.id === 1814 ? 3 : 6
    const fields = parseFields(unhex(request.hex))
    const index = fields.get(field)![0] as bigint
    request.hex = hex(concat([...fields].map(([n, values]) => n === field ? numberField(n, 1n - index) : lengthField(n, values[0] as Uint8Array))))
  }
  const r = replay(c), signed = await signMoneroStream(c.plan, r.exchange)
  expect(hex(signed.blob)).toBe(c.transactionHex)
  expect(c.requests.filter(r => r.id === 1814).map(r => parseFields(unhex(r.hex)).get(3))).toEqual([[1n], [0n]])
  expect(c.requests.filter(r => r.id === 1822).map(r => parseFields(unhex(r.hex)).get(6))).toEqual([[1n], [0n]])
})

test('unsupported output counts and ring sizes fail before the first exchange, with localized errors', async () => {
  for (const count of [0, 1, 3]) {
    const plan = structuredClone(cases[0].plan)
    plan.outputs = Array.from({ length: count }, (_, i) => cases[0].plan.outputs[i % 2])
    let calls = 0
    await expect(signMoneroStream(plan, async () => { calls++; throw Error('must not exchange') }, { text: s => `localized: ${s}` })).rejects.toThrow(`localized: ${STREAM_ERRORS.outputs}`)
    expect(calls).toBe(0)
  }
  for (const size of [0, 15, 17]) {
    const plan = structuredClone(cases[0].plan); plan.inputs[0].ring.length = size
    let calls = 0
    await expect(signMoneroStream(plan, async () => { calls++; throw Error('must not exchange') })).rejects.toThrow('ring size of 16')
    expect(calls).toBe(0)
  }
})

test('change, totals, duplicate inputs, additional-key indices and unsorted rings fail preflight', () => {
  const mutations = [
    (p: MoneroPlan) => { p.outputs[1].isChange = false },
    (p: MoneroPlan) => { p.outputs[1].changeMinor = 1 },
    (p: MoneroPlan) => { p.outputs[0].amountAtomic = '1' },
    (p: MoneroPlan) => { p.inputs.push(structuredClone(p.inputs[0])) },
    (p: MoneroPlan) => { p.inputs[0].additionalTxPublicKeys = [p.inputs[0].txPublicKey]; p.inputs[0].outputIndex = 1 },
    (p: MoneroPlan) => { p.inputs[0].ring.reverse() },
  ]
  for (const mutate of mutations) { const plan = structuredClone(cases[0].plan); mutate(plan); expect(() => checkStreamSigningBounds(plan)).toThrow() }
})

test('prefix mismatch aborts before SignInput or Final', async () => {
  const r = replay(cases[0], (id, body) => {
    if (id === 1821) bytesField(parseFields(body), 2)[0] ^= 1
    return body
  })
  await expect(signMoneroStream(cases[0].plan, r.exchange)).rejects.toThrow(STREAM_ERRORS.prefix)
  expect(r.ids.at(-1)).toBe(1820)
  expect(r.ids).not.toContain(1822)
  expect(r.ids).not.toContain(1824)
})

test('altered sealed CLSAG or opening key fails authentication after Final', async () => {
  for (const changedId of [1823, 1825]) {
    const r = replay(cases[0], (id, body) => { if (id === changedId) bytesField(parseFields(body), 1)[0] ^= 1; return body })
    await expect(signMoneroStream(cases[0].plan, r.exchange)).rejects.toThrow('authentication')
    expect(r.ids.at(-1)).toBe(1824)
    expect(r.consumed.every(b => b.every(v => v === 0))).toBe(true)
  }
})

test('device failure at any step is propagated once without replaying a request', async () => {
  for (let failAt = 0; failAt < cases[0].requests.length; failAt++) {
    const r = replay(), seen: number[] = []
    await expect(signMoneroStream(cases[0].plan, async (...args) => {
      seen.push(args[0])
      if (seen.length === failAt + 1) throw Error('fixture cancellation')
      return r.exchange(...args)
    })).rejects.toThrow('fixture cancellation')
    expect(seen).toEqual(cases[0].requests.slice(0, failAt + 1).map(r => r.id))
  }
})

test('bad response counts, MAC sizes, input bytes, output keys and proof lengths are refused', async () => {
  const mutations: Array<[number, (body: Uint8Array) => Uint8Array]> = [
    [1811, body => concat([body, lengthField(1, new Uint8Array(32))])],
    [1811, body => { body[body.length - 1] = 1; return body }],
    [1813, body => { bytesField(parseFields(body), 1)[3] ^= 1; return body }],
    [1813, body => concat([body, lengthField(2, new Uint8Array(31))])],
    [1815, () => numberField(1, 1)],
    [1819, body => { bytesField(parseFields(body), 2)[0] ^= 1; return body }],
    [1821, body => concat([body, numberField(3, 1)])],
    [1825, () => lengthField(1, new Uint8Array(31))],
  ]
  for (const [changedId, mutate] of mutations) {
    const r = replay(cases[0], (id, body) => id === changedId ? mutate(body) : body)
    await expect(signMoneroStream(cases[0].plan, r.exchange)).rejects.toThrow()
  }
})

test('Core native plan fills every source slot without changing the pinned ABI', () => {
  const plan = cases[1].plan, native = coreNativePlan(plan), view = new DataView(native.buffer)
  expect(native.length).toBe(7544)
  expect(view.getUint32(4, true)).toBe(2)
  for (const [index, input] of plan.inputs.entries()) {
    expect(view.getBigUint64(24 + index * 1760, true)).toBe(BigInt(input.amountAtomic))
    expect(hex(native.subarray(24 + index * 1760 + 24, 24 + index * 1760 + 56))).toBe(input.txPublicKey)
  }
})

// Optional qualification against the actual hash-pinned library, never a device.
const nativeDirectory = process.env.MONERO_CORE_VERIFY_DIR
const verifier = createMoneroCoreVerifier({ directory: nativeDirectory ?? '/private/tmp/no-monero-verifier' })
test.skipIf(!nativeDirectory)('pinned native Core verifier accepts firmware vectors and rejects a corrupted signature', () => {
  expect(verifier.available()).toBe(true)
  for (const c of cases) {
    const prepared = verifier.prepare(c.plan)
    try {
      const blob = unhex(c.transactionHex)
      expect(prepared.verify(blob)).toBe(true)
      blob[blob.length - c.plan.inputs.length * 32 - 70] ^= 1
      expect(prepared.verify(blob)).toBe(false)
    } finally { prepared.dispose() }
  }
})
