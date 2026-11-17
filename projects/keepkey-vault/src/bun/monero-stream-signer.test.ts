import sweepFixtures from './monero-stream-sweep.fixtures.json'
import { backendText } from './i18n'
import { SUPPORTED_LANGUAGES } from '../mainview/i18n/languages'
import { expect, test } from 'bun:test'
import { ed25519 } from '@noble/curves/ed25519'
import { verifyMoneroTransactionKeys } from './monero-transaction-keys'
import { STREAM_MONITORING_KEY_ERROR, STREAM_OUTPUT_BINDING_ERROR, streamNeedsMonitoringKey, validateStreamMonitoringKey,
  verifyStreamOutputBindings } from './monero-stream-output-binding'
import { moneroDestinationAddressKeys } from '../shared/monero-address'
import { keccak_256 } from '@noble/hashes/sha3'
import { readFileSync } from 'node:fs'
import type { MoneroPlan } from '../../monero-cli/src/protocol'
import { bytesField, concat, lengthField, numberField, parseFields, parseSignedTransaction } from './monero-wire'
import { checkStreamSigningBounds, signMoneroStream as signMoneroStreamRaw, streamDestination, streamInitRequest, streamSource, supportsMoneroSigning, STREAM_ERRORS, type MoneroSigningPhase } from './monero-stream-signer'
import { coreNativePlan, createMoneroCoreVerifier } from './monero-device-signing'

const fixtures = JSON.parse(readFileSync(new URL('./monero-stream.fixtures.json', import.meta.url), 'utf8'))
const cases = fixtures.cases as Array<{ name: string; plan: MoneroPlan; requests: Array<{ id: number; hex: string }>; responses: Array<{ id: number; hex: string }>; transactionHex: string; prefixHash: string; transactionKeccak: string }>
const unhex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
// Public abandon-account fixture only, independently specified by the firmware vectors.
const PUBLIC_VIEW = unhex('84b0087a63854856686f80596a5a1a6090795b4d1311139173262170d7e7180f')
const signMoneroStream: typeof signMoneroStreamRaw = (plan, exchange, options) => signMoneroStreamRaw(plan, exchange, { senderViewKey: PUBLIC_VIEW, ...options })

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
  for (const c of [...cases, ...sweepFixtures.cases]) {
    const prepared = verifier.prepare(c.plan as MoneroPlan)
    try {
      const blob = unhex(c.transactionHex)
      expect(prepared.verify(blob)).toBe(true)
      blob[blob.length - c.plan.inputs.length * 32 - 70] ^= 1
      expect(prepared.verify(blob)).toBe(false)
    } finally { prepared.dispose() }
  }
})


test('Final releases verified standard and subaddress payment keys and scrubs reply buffers', async () => {
 for (const c of cases) {
  const r = replay(c), signed = await signMoneroStream(c.plan, r.exchange)
  const expected = hex(bytesField(parseFields(unhex(c.responses.at(-1)!.hex)), 2))
  expect(signed.transactionKeys).toEqual({txKey:expected,additionalTxKeys:[]})
  expect(r.consumed.every(b => b.every(v => v === 0))).toBe(true)
 }
})

test('missing, duplicate, noncanonical or mismatched Final payment keys fail closed', async () => {
 const L = (1n << 252n) + 27742317777372353535851937790883648493n
 const scalar = (n: bigint) => Uint8Array.from({length:32}, (_,i) => Number(n >> BigInt(i * 8) & 255n))
 for (const key of [new Uint8Array(31), scalar(0n), scalar(L), scalar(1n)]) {
  const r = replay(cases[0], (id, body) => id === 1825 ? concat([lengthField(1, bytesField(parseFields(body), 1)), lengthField(2, key)]) : body)
  await expect(signMoneroStream(cases[0].plan, r.exchange)).rejects.toThrow()
 }
 for (const extra of [new Uint8Array(), lengthField(2, scalar(1n)), lengthField(3, scalar(1n))]) {
  const r = replay(cases[0], (id, body) => id === 1825 ? extra.length ? concat([body, extra]) : lengthField(1, bytesField(parseFields(body), 1)) : body)
  await expect(signMoneroStream(cases[0].plan, r.exchange)).rejects.toThrow()
 }
})

test('mixed subaddress and dummy outputs bind additional payment keys in output order', () => {
 const plan = structuredClone(cases[1].plan)
 for (const o of plan.outputs) o.isChange = false
 const scalar = (n: number) => new Uint8Array([n, ...Array(31).fill(0)])
 const key = scalar(7), additional = [scalar(8), scalar(9)]
 const publicKeys = plan.outputs.map((o,i) => {
  const keys = moneroDestinationAddressKeys(o.address)!
  const base = keys.kind === 'subaddress' ? ed25519.ExtendedPoint.fromHex(keys.spend) : ed25519.ExtendedPoint.BASE
  return base.multiply(BigInt(8+i)).toRawBytes()
 })
 const extra = concat([new Uint8Array([1]),ed25519.ExtendedPoint.BASE.multiply(7n).toRawBytes(),new Uint8Array([4,2]),...publicKeys,new Uint8Array([2,9,1]),new Uint8Array(8)])
 expect(verifyMoneroTransactionKeys(plan, extra, key, additional).additionalTxKeys).toEqual(additional.map(hex))
 expect(() => verifyMoneroTransactionKeys(plan, extra, key, [...additional].reverse())).toThrow()
 expect(() => verifyMoneroTransactionKeys(plan, extra, key, [])).toThrow()
 expect(() => verifyMoneroTransactionKeys(plan, concat([extra,new Uint8Array([0])]), key, additional)).toThrow()
})


test('nonzero unlock time fails locally before Init, in every supported language', async () => {
 const source = 'Monero unlock time must be zero. Nothing was signed.'
 for (const language of SUPPORTED_LANGUAGES) {
  const translated = backendText(language, source)
  if (language !== 'en') expect(translated).not.toBe(source)
  for (const unlockTime of ['1', '3000000', '18446744073709551615']) {
   const plan = {...structuredClone(cases[0].plan), unlockTime}
   let calls = 0
   await expect(signMoneroStream(plan, async () => {calls++; throw Error('must not exchange')}, {text:s=>backendText(language,s)})).rejects.toThrow(translated)
   expect(calls).toBe(0)
  }
 }
})

test('send-max standard/subaddress sweeps in both orders preserve the zero output through assembly', async () => {
 for (const c of sweepFixtures.cases) {
  const r = replay(c as typeof cases[0]), signed = await signMoneroStream(c.plan as MoneroPlan, r.exchange)
  expect(hex(signed.blob)).toBe(c.transactionHex)
  const data = parseFields(bytesField(parseFields(unhex(c.requests[0].hex)),3))
  expect(data.has(2)).toBe(false) // no change_dts
  expect(c.plan.outputs.find(o=>o.amountAtomic==='0')).toBeDefined()
  expect(signed.transactionKeys.additionalTxKeys).toHaveLength(c.name.startsWith('sweep-1') ? 2 : 0)
 }
})

test('full message hash, ecdh or proof corruption aborts before signatures', async () => {
 for (const mutation of ['message','ecdh','proof']) {
  const r = replay(cases[0], (id,body) => {
   const fields = parseFields(body)
   if (mutation==='message' && id===1821) bytesField(fields,5)[0]^=1
   if (mutation==='ecdh' && id===1819) bytesField(fields,3)[0]^=1
   if (mutation==='proof' && id===1819 && fields.has(4)) bytesField(fields,4)[0]^=1
   return body
  })
  await expect(signMoneroStream(cases[0].plan,r.exchange)).rejects.toThrow('message hash')
  expect(r.ids.at(-1)).toBe(1820)
  expect(r.ids).not.toContain(1822); expect(r.ids).not.toContain(1824)
 }
})

function finalPaymentKeys(c: typeof cases[0]) {
  const fields = parseFields(unhex(c.responses.at(-1)!.hex))
  return { key: bytesField(fields, 2), additional: (fields.get(3) ?? []) as Uint8Array[] }
}

test('output binding reconstructs every standard, subaddress and sweep output from independent Core vectors', () => {
  for (const c of [...cases, ...sweepFixtures.cases] as typeof cases) {
    const parsed = parseSignedTransaction(unhex(c.transactionHex)), keys = finalPaymentKeys(c)
    expect(verifyStreamOutputBindings(c.plan, parsed, keys.key, keys.additional, PUBLIC_VIEW)).toEqual({
      txKey: hex(keys.key), additionalTxKeys: keys.additional.map(hex),
    })
    expect(streamNeedsMonitoringKey(c.plan)).toBe(c.name === '2in-2out-subaddress')
  }
})

test('an otherwise valid signed transaction cannot be substituted for another recipient, amount or output order', () => {
  for (const c of cases) {
    // Blob, CLSAGs and Bulletproof+ stay unchanged and valid. Ring/proof-only
    // verification cannot detect that these plans authorize different payments.
    const parsed = parseSignedTransaction(unhex(c.transactionHex)), keys = finalPaymentKeys(c)
    const changes: Array<(plan: MoneroPlan) => void> = [
      p => { p.outputs.find(o => !o.isChange)!.address = sweepFixtures.cases[0].plan.outputs[1].address },
      p => { p.outputs.find(o => !o.isChange)!.amountAtomic = (BigInt(p.outputs.find(o => !o.isChange)!.amountAtomic) + 1n).toString() },
      p => { p.outputs.find(o => o.isChange)!.amountAtomic = (BigInt(p.outputs.find(o => o.isChange)!.amountAtomic) - 1n).toString() },
      p => { p.outputs.reverse() },
    ]
    for (const mutate of changes) {
      const plan = structuredClone(c.plan); mutate(plan)
      expect(() => verifyStreamOutputBindings(plan, parsed, keys.key, keys.additional, PUBLIC_VIEW)).toThrow()
    }
  }
})

test('altered output keys, view tags, encrypted amounts and commitments fail independent output binding', () => {
  for (const c of cases) {
    const keys = finalPaymentKeys(c)
    const changes: Array<(parsed: ReturnType<typeof parseSignedTransaction>) => void> = [
      p => { p.outputData[2] ^= 1 }, p => { p.outputData[34] ^= 1 },
      p => { p.outputData[35 + 2] ^= 1 }, p => { p.outputData[35 + 34] ^= 1 },
      p => { p.encryptedAmounts[0] ^= 1 }, p => { p.encryptedAmounts[8] ^= 1 },
      p => { p.commitments[0] ^= 1 }, p => { p.commitments[32] ^= 1 },
    ]
    for (const mutate of changes) {
      const parsed = parseSignedTransaction(unhex(c.transactionHex)); mutate(parsed)
      expect(() => verifyStreamOutputBindings(c.plan, parsed, keys.key, keys.additional, PUBLIC_VIEW)).toThrow(STREAM_OUTPUT_BINDING_ERROR)
    }
  }
})

test('subaddress change requires the matching approved monitoring key before any device I/O', async () => {
  const c = cases[1]
  expect(() => validateStreamMonitoringKey(c.plan, PUBLIC_VIEW)).not.toThrow()
  for (const key of [undefined, new Uint8Array(32), new Uint8Array(31), new Uint8Array(32).fill(1)]) {
    let calls = 0
    await expect(signMoneroStreamRaw(c.plan, async () => { calls++; throw Error('must not exchange') }, { senderViewKey: key })).rejects.toThrow(STREAM_MONITORING_KEY_ERROR)
    expect(calls).toBe(0)
  }
  // Standard and sweep transactions need no monitoring credential.
  expect(() => validateStreamMonitoringKey(cases[0].plan)).not.toThrow()
  for (const c of sweepFixtures.cases) expect(() => validateStreamMonitoringKey(c.plan as MoneroPlan)).not.toThrow()
})

test('stream signing owns a monitoring-key copy across awaits and leaves the caller buffer intact', async () => {
  const c = cases[1], caller = PUBLIC_VIEW.slice(), r = replay(c)
  const signed = await signMoneroStreamRaw(c.plan, async (...args) => {
    caller.fill(0) // replacing the caller's bytes cannot change the authorization in flight
    return r.exchange(...args)
  }, { senderViewKey: caller })
  expect(hex(signed.blob)).toBe(c.transactionHex)
  expect(caller.every(v => v === 0)).toBe(true)
  expect(PUBLIC_VIEW.some(v => v !== 0)).toBe(true)
})
