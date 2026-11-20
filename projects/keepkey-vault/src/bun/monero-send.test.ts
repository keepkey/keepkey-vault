import { describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createMoneroWatchStore, type MoneroWatchStore } from './monero-watch-store'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { checkRelayResponse, parseExactJson, validateKeyImageImport, validateOutputs, validatePlan, validateRelayRequest,
  validateTransferRequest, type MoneroPlan } from '../../monero-cli/src/protocol'
import { relayRawTransaction } from '../../monero-cli/src/wallet'
import { DigestWalletRpc } from '../../monero-cli/src/digest'
import { checkSignedTransaction, concat, keyImageInitRequest, lengthField, openKeyImage, parseFields, parseSignedTransaction, reviewPlan,
  signRequest, transferDetails, varint, bytesField } from './monero-wire'
import { createMoneroVault, type MoneroWatchSidecar } from './monero-vault'
import { MONERO_STANDARD_WALLET_REQUIRED } from '../shared/monero-wallet-policy'
import { createMoneroCoreVerifier, type MoneroCoreVerifier } from './monero-device-signing'
import streamFixtures from './monero-stream.fixtures.json'
import sweepFixtures from './monero-stream-sweep.fixtures.json'
import { createFilePendingStore, type MoneroPendingStore } from './monero-pending'
import { formatXmrAtomic, moneroAddressKind, parseXmrAmount } from '../shared/monero-address'

// Public research fixtures only (scripts/make-monero-send-fixtures.py, from the firmware tree's
// evidence/2026-11-04-host plans). No device, daemon, adapter or wallet is touched.
const raw = readFileSync(join(import.meta.dir, 'monero-send.fixtures.json'), 'utf8')
const fixtures = parseExactJson(raw)
const CASES = Object.keys(fixtures.cases)
const base = fixtures.cases.base
const WALLET = base.walletAddress as string
const RECIPIENT = '4Ahp23WfMrMFK3wYL2hLWQFGt87ZTeRkufS6JoQZu6MEFDokAQeGWmu9MA3GFq1yVLSJQbKJqVAn9F9DLYGpRzRAEXqAXKM'
const SUBADDRESS = '84AxZu7xYb7fi7hnQrgTBdHFyP2xz6vdrZbLaJxbe73JJTWj6JG4cV8cbNnEhMvvi9PxSHvGnXQiaaLf2HNXJfzFKtWqk3H'
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
const unhex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
const planOf = (name: string): MoneroPlan => validatePlan(structuredClone(fixtures.cases[name].adapterPlan))
const ownedOf = (name: string) => {
  const outputs = validateOutputs(structuredClone(fixtures.cases[name].adapterOutputs)), images = fixtures.cases[name].signedTransaction.keyImages as string[]
  const plan = planOf(name)
  // Key images are keyed by the real ring member each plan input spends.
  return new Map(outputs.map(output => {
    const index = plan.inputs.findIndex(input => input.ring[input.realMember].publicKey === output.outKey)
    return [output.outKey, { amountAtomic: output.amountAtomic, keyImage: images[index] }]
  }))
}
const blobOf = (name: string) => unhex(fixtures.cases[name].signedTransaction.hex)
const referenceHash = (name: string) => {
  const { prefixEnd, baseEnd } = fixtures.cases[name].signedTransaction, blob = blobOf(name)
  const [p, b] = [Number(prefixEnd), Number(baseEnd)]
  return hex(keccak_256(concat([keccak_256(blob.subarray(0, p)), keccak_256(blob.subarray(p, b)), keccak_256(blob.subarray(b))])))
}
const intent = (name = 'base', overrides: Record<string, unknown> = {}) => ({ address: RECIPIENT, amountAtomic: '2000000000000', walletAddress: WALLET,
  walletFeeAtomic: '20000000', walletAmountAtomic: '2000000000000', owned: ownedOf(name), ...overrides }) as Parameters<typeof reviewPlan>[1]

describe('Monero research wire encoding against the firmware fixtures', () => {
  test('65000 request bytes equal the Python reference encode_plan for every fixture plan', () => {
    for (const name of CASES) expect(hex(signRequest(planOf(name)))).toBe(fixtures.cases[name].signRequestHex)
  })

  test('key-image transfer details equal the reference encoding; init carries count, transcript hash, path, mainnet', () => {
    for (const name of CASES) {
      const outputs = validateOutputs(structuredClone(fixtures.cases[name].adapterOutputs))
      expect(outputs.map(output => hex(transferDetails(output)))).toEqual(fixtures.cases[name].transferDetailsHex)
      const fields = parseFields(keyImageInitRequest(outputs))
      expect(fields.get(1)).toEqual([BigInt(outputs.length)])
      expect(fields.get(3)).toEqual([0x8000002cn, 0x80000080n, 0x80000000n])
      expect(fields.get(4)).toEqual([0n])
      const transcript = keccak_256(concat(outputs.map(output => keccak_256(concat([unhex(output.outKey), unhex(output.txPublicKey),
        ...output.additionalTxPublicKeys.map(unhex), varint(BigInt(output.outputIndex))])))))
      expect(hex(fields.get(2)![0] as Uint8Array)).toBe(hex(transcript))
    }
  })

  test('key-image records open with the libsodium-sealed fixture and refuse tampering', () => {
    const sealed = fixtures.sealedKeyImage
    const opened = openKeyImage(unhex(sealed.key), unhex(sealed.iv), unhex(sealed.blob))
    expect(opened.keyImage + opened.signature).toBe(sealed.plaintext)
    const tampered = unhex(sealed.blob); tampered[5] ^= 1
    expect(() => openKeyImage(unhex(sealed.key), unhex(sealed.iv), tampered)).toThrow('authentication')
    expect(() => openKeyImage(unhex(sealed.key), unhex(sealed.iv).subarray(0, 11), unhex(sealed.blob))).toThrow('Invalid')
  })

  test('signed transactions parse to the reference layout and hash; truncation and trailing bytes are refused', () => {
    for (const name of CASES) {
      const parsed = parseSignedTransaction(blobOf(name)), plan = planOf(name)
      expect(parsed.hash).toBe(referenceHash(name))
      expect(parsed.fee).toBe(BigInt(plan.feeAtomic))
      expect(parsed.inputs.map(input => input.keyImage)).toEqual(fixtures.cases[name].signedTransaction.keyImages)
      expect(parsed.inputs[0].indices).toEqual(plan.inputs[0].ring.map(member => BigInt(member.globalIndex)))
      checkSignedTransaction(parsed, referenceHash(name), plan, ownedOf(name))
    }
    const blob = blobOf('base')
    expect(() => parseSignedTransaction(blob.subarray(0, blob.length - 1))).toThrow('invalid Monero transaction')
    expect(() => parseSignedTransaction(concat([blob, new Uint8Array([0])]))).toThrow('invalid Monero transaction')
    const version = blob.slice(); version[0] = 1
    expect(() => parseSignedTransaction(version)).toThrow('invalid Monero transaction')
  })

  test('a signed transaction with another hash, ring, fee or input is never relayed', () => {
    const plan = planOf('base'), owned = ownedOf('base'), parsed = parseSignedTransaction(blobOf('base'))
    expect(() => checkSignedTransaction(parsed, '00'.repeat(32), plan, owned)).toThrow('not sent')
    expect(() => checkSignedTransaction({ ...parsed, fee: parsed.fee + 1n }, parsed.hash, plan, owned)).toThrow('not sent')
    const ring = { ...parsed, inputs: [{ ...parsed.inputs[0], indices: parsed.inputs[0].indices.map((index, i) => i ? index : index + 1n) }] }
    expect(() => checkSignedTransaction(ring, parsed.hash, plan, owned)).toThrow('not sent')
    const other = { ...parsed, inputs: [{ ...parsed.inputs[0], keyImage: 'ee'.repeat(32) }] }
    expect(() => checkSignedTransaction(other, parsed.hash, plan, owned)).toThrow('not sent')
  })
})

describe('plan versus the user intent', () => {
  test('the base fixture is exactly the payment plus change back to this wallet', () => {
    const review = reviewPlan(planOf('base'), intent())
    expect(review).toEqual({ recipient: RECIPIENT, amountAtomic: '2000000000000', feeAtomic: '20000000', changeAtomic: '4999980000000',
      totalAtomic: '2000020000000', inputCount: 1, outputs: [
        { role: 'recipient', address: RECIPIENT, amountAtomic: '2000000000000' }, { role: 'change', address: WALLET, amountAtomic: '4999980000000' }] })
    expect(reviewPlan(planOf('four-inputs-reversed-selection'), intent('four-inputs-reversed-selection')).inputCount).toBe(4)
  })

  test('recipient, amount, wallet fee, change, input ownership and totals mismatches are refused', () => {
    const plan = planOf('base')
    expect(() => reviewPlan(plan, intent('base', { address: SUBADDRESS }))).toThrow('recipient')
    expect(() => reviewPlan(plan, intent('base', { amountAtomic: '2000000000001' }))).toThrow('amount')
    expect(() => reviewPlan(plan, intent('base', { walletAmountAtomic: '1' }))).toThrow('amount')
    expect(() => reviewPlan(plan, intent('base', { walletFeeAtomic: '20000001' }))).toThrow('fee')
    expect(() => reviewPlan(plan, intent('base', { walletAddress: RECIPIENT }))).toThrow()
    expect(() => reviewPlan(plan, intent('base', { owned: new Map() }))).toThrow('input')
    const wrongAmount = new Map([...ownedOf('base')].map(([key, value]) => [key, { ...value, amountAtomic: '1' }]))
    expect(() => reviewPlan(plan, intent('base', { owned: wrongAmount }))).toThrow('input')
    const stolenChange = structuredClone(plan); stolenChange.outputs[1].address = SUBADDRESS
    expect(() => reviewPlan(stolenChange, intent())).toThrow('change')
    const subChange = structuredClone(plan); subChange.outputs[1].changeMinor = 1
    expect(() => reviewPlan(subChange, intent())).toThrow('change')
    const second = structuredClone(plan); second.outputs[1].isChange = false
    expect(() => reviewPlan(second, intent())).toThrow('recipient')
    const inflated = structuredClone(plan); inflated.outputs[1].amountAtomic = '4999980000001'
    expect(() => reviewPlan(inflated, intent())).toThrow('totals')
  })
})

describe('sidecar protocol validation', () => {
  test('adapter plans outside the research signer bounds are refused', () => {
    const good = fixtures.cases.base.adapterPlan
    const variant = (change: (value: any) => void) => { const value = structuredClone(good); change(value); return () => validatePlan(value) }
    expect(validatePlan(structuredClone(good)).inputs[0].ring).toHaveLength(16)
    expect(variant(v => v.inputs[0].ring.pop())).toThrow()
    expect(variant(v => { v.inputs[0].ring[3].global_index = v.inputs[0].ring[2].global_index })).toThrow('increase')
    expect(variant(v => { v.inputs = Array(5).fill(v.inputs[0]) })).toThrow()
    expect(variant(v => v.outputs.pop())).toThrow()
    const zero = structuredClone(good); zero.outputs[1].amount = '0'; zero.outputs[1].is_change = false
    expect(validatePlan(zero).outputs[1].amountAtomic).toBe('0')
    expect(variant(v => { v.outputs[0].address = v.outputs[0].address + 'xxxxxxxxxxx' })).toThrow()
    expect(variant(v => { v.network = '1' })).toThrow()
    expect(variant(v => { v.spendkey = 'never' })).toThrow()
    expect(variant(v => { v.fee = '18446744073709551616' })).toThrow()
  })

  test('output exports keep wallet transfer order and unique outputs', () => {
    const good = fixtures.cases['four-inputs-reversed-selection'].adapterOutputs
    expect(validateOutputs(structuredClone(good))).toHaveLength(4)
    const reordered = structuredClone(good); reordered.outputs.reverse()
    expect(() => validateOutputs(reordered)).toThrow()
    const duplicate = structuredClone(good); duplicate.outputs[1].out_key = duplicate.outputs[0].out_key
    expect(() => validateOutputs(duplicate)).toThrow('Duplicate')
    expect(() => validateOutputs({ ...structuredClone(good), offset: '1' })).toThrow()
  })

  test('transfer, key-image and relay requests are strictly bounded', () => {
    expect(validateTransferRequest({ address: SUBADDRESS, amountAtomic: '1', priority: 0 }).address).toBe(SUBADDRESS)
    expect(() => validateTransferRequest({ address: RECIPIENT, amountAtomic: '0', priority: 0 })).toThrow()
    expect(() => validateTransferRequest({ address: RECIPIENT, amountAtomic: 1, priority: 0 })).toThrow()
    expect(() => validateTransferRequest({ address: RECIPIENT + 'x'.repeat(11), amountAtomic: '1', priority: 0 })).toThrow()
    expect(() => validateTransferRequest({ address: RECIPIENT, amountAtomic: '1', priority: 5 })).toThrow()
    const image = { keyImage: 'aa'.repeat(32), signature: 'bb'.repeat(64) }
    expect(validateKeyImageImport({ offset: 0, signedKeyImages: [image] }).signedKeyImages).toEqual([image])
    expect(() => validateKeyImageImport({ offset: 1, signedKeyImages: [image] })).toThrow()
    expect(() => validateKeyImageImport({ offset: 0, signedKeyImages: Array(65).fill(image) })).toThrow()
    expect(() => validateRelayRequest({ txHex: 'ab'.repeat(16385) })).toThrow()
    expect(() => validateRelayRequest({ txHex: 'abc' })).toThrow()
  })

  test('uint64 transfer amounts reach wallet RPC as exact JSON integers', async () => {
    const rpc = new DigestWalletRpc(1, 'test', 'test')
    let body = ''
    ;(rpc as any).exchange = async (value: string) => { body = value; return { status: 200, body: '{"jsonrpc":"2.0","id":"1","result":{}}' } }
    await rpc.call('transfer', { destinations: [{ address: RECIPIENT, amount: 18446744073709551615n }] })
    expect(body).toContain('"amount":18446744073709551615}')
    rpc.close()
  })
})

describe('daemon relay', () => {
  const ok = { status: 'OK', reason: '', not_relayed: false, low_mixin: false, double_spend: false, invalid_input: false, invalid_output: false,
    too_big: false, overspend: false, fee_too_low: false, too_few_outputs: false, sanity_check_failed: false, tx_extra_too_big: false, nonzero_unlock_time: false }
  const reply = (value: unknown, status = 200) => async () => new Response(JSON.stringify(value), { status })

  test('every daemon failure flag is checked, not only status', () => {
    expect(() => checkRelayResponse(ok)).not.toThrow()
    expect(() => checkRelayResponse({ ...ok, double_spend: true, status: 'Failed' })).toThrow('double spend')
    expect(() => checkRelayResponse({ ...ok, fee_too_low: true, status: 'Failed' })).toThrow('fee too low')
    expect(() => checkRelayResponse({ ...ok, sanity_check_failed: true })).toThrow('rejected')
    // No rejection flag: not a rejection (nothing proves nothing was sent), so an unknown outcome to look up.
    expect(() => checkRelayResponse({ ...ok, status: 'BUSY' })).toThrow('did not relay')
    expect(() => checkRelayResponse({ ...ok, not_relayed: true })).toThrow('did not relay')
    expect(() => checkRelayResponse({ status: 'OK' })).toThrow('did not relay')
  })

  test('relay posts the raw hex once to the configured origin and maps failures to fixed messages', async () => {
    const calls: Array<{ url: string; init: any }> = []
    await relayRawTransaction('http://127.0.0.1:18081', undefined, 'abcd', async (url, init) => { calls.push({ url, init }); return reply(ok)() })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:18081/send_raw_transaction')
    expect(JSON.parse(calls[0].init.body)).toEqual({ tx_as_hex: 'abcd', do_not_relay: false })
    expect(calls[0].init.redirect).toBe('error')
    await expect(relayRawTransaction('http://127.0.0.1:18081', undefined, 'abcd', reply({ ...ok, double_spend: true }))).rejects.toThrow('double spend')
    await expect(relayRawTransaction('http://127.0.0.1:18081', undefined, 'abcd', reply(ok, 500))).rejects.toThrow('unavailable')
    await expect(relayRawTransaction('http://127.0.0.1:18081', undefined, 'abcd', async () => { throw new Error('ECONNREFUSED secret') })).rejects.toThrow('The Monero daemon is unavailable')
  })

  test('garbage replies are unknown outcomes, never a rejection that would clear the pending tx', async () => {
    for (const body of ['x'.repeat(70000), 'not json', '[1,2]', 'null', '"OK"', '{"status":"Failed"}', '{"status":"OK"}']) {
      const error = await relayRawTransaction('http://127.0.0.1:18081', undefined, 'abcd', async () => new Response(body)).catch(e => e)
      expect(error.message).not.toStartWith('The daemon rejected')
      expect(['The daemon reply could not be read', 'The daemon accepted the transaction but did not relay it']).toContain(error.message)
    }
  })

  test('monerod 0.18.5.4 re-send of a tx it already has (pool or block): OK + not_relayed, an unknown outcome', () => {
    // Recorded on an offline regtest chain: the second and third /send_raw_transaction of the same bytes.
    const resend = { ...ok, not_relayed: true, reason: 'Not relayed', status: 'OK' }
    expect(() => checkRelayResponse(resend)).toThrow('The daemon accepted the transaction but did not relay it')
  })

  test('HTTPS relay requires the configured certificate pin; remote HTTP is refused', async () => {
    let tls: any = null
    await expect(relayRawTransaction('https://node.example', undefined, 'ab', reply(ok))).rejects.toThrow('origin')
    await expect(relayRawTransaction('http://node.example', undefined, 'ab', reply(ok))).rejects.toThrow('origin')
    const certificate = new Uint8Array([1, 2, 3]), pin = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', certificate)))
    await relayRawTransaction('https://node.example', pin, 'ab', async (_url, init) => { tls = init.tls; return reply(ok)() })
    expect(tls.checkServerIdentity('node.example', { raw: certificate })).toBeUndefined()
    expect(tls.checkServerIdentity('node.example', { raw: new Uint8Array([9]) })).toBeInstanceOf(Error)
  })
})

describe('mainnet address and amount entry', () => {
  test('standard and subaddress pass; integrated, wrong checksum and other networks do not', () => {
    expect(moneroAddressKind(WALLET)).toBe('standard')
    expect(moneroAddressKind(SUBADDRESS)).toBe('subaddress')
    expect(moneroAddressKind(WALLET.slice(0, -1) + (WALLET.endsWith('R') ? 'S' : 'R'))).toBeNull()
    expect(moneroAddressKind('4' + '1'.repeat(94))).toBeNull()
    expect(moneroAddressKind(12)).toBeNull()
  })

  test('amounts stay exact and use the device format', () => {
    expect(parseXmrAmount('2')).toBe('2000000000000')
    expect(parseXmrAmount('0.000000000001')).toBe('1')
    expect(parseXmrAmount('18446744.073709551615')).toBe('18446744073709551615')
    expect(parseXmrAmount('18446744.073709551616')).toBeNull()
    for (const bad of ['0', '0.0', '1.0000000000001', '-1', '1e3', '', '.5']) expect(parseXmrAmount(bad)).toBeNull()
    expect(formatXmrAtomic('4999980000000')).toBe('4.999980000000 XMR')
  })
})

// ── Desktop bridge with a public message-level emulator fake ──

function reports(type: number, body: Uint8Array = new Uint8Array()): Uint8Array[] {
  const stream = new Uint8Array(8 + body.length); stream.set([35, 35])
  const view = new DataView(stream.buffer); view.setUint16(2, type); view.setUint32(4, body.length); stream.set(body, 8)
  const result: Uint8Array[] = []
  for (let offset = 0; offset < stream.length; offset += 63) {
    const report = new Uint8Array(64); report[0] = 63; report.set(stream.subarray(offset, offset + 63), 1); result.push(report)
  }
  return result
}
const ENC_KEY = new Uint8Array(32).fill(9)

class Emulator {
  streamFixture: typeof streamFixtures.cases[number] | null = null
  streamPosition = 0
  streamHook: ((type: number) => Promise<void>) | null = null
  onButtonRequest: (() => void) | null = null
  queue: Uint8Array[] = []
  pending: Array<[number, Uint8Array]> = []
  received: Array<{ type: number; body: Uint8Array }> = []
  partial: { type: number; length: number; data: number[] } | null = null
  keyImageOverride:string|null=null
  keyImageOverrides = new Map<string,string>()
  watchViewKey = new Uint8Array(32).fill(7)
  signedBlob = blobOf('base')
  signedHash = unhex(referenceHash('base'))
  reviewScreens = 3
  address = WALLET
  /** PinMatrixRequest (18) instead of an answer: a PIN-locked wallet. */
  pinLocked = false
  /** Runs at each 65000 review screen (switch device / turn Monero off mid-signing). */
  onReviewScreen: (() => void) | null = null
  private respond(messages: Array<[number, Uint8Array]>) {
    const [first, ...rest] = messages
    const type = this.streamFixture ? ({541:1801,543:1803,531:1805,533:1807,535:1809}[first[0]] ?? first[0]) : first[0]
    this.queue.push(...reports(type, first[1]))
    if (first[0] === 26) this.pending = rest
  }
  publicOnly = false
  private handle(type: number, body: Uint8Array) {
    this.received.push({ type, body })
    if (type >= 1810 && type <= 1824 && this.streamFixture) {
      const c = this.streamFixture, index = this.streamPosition++
      expect({id:type, hex:hex(body)}).toEqual(c.requests[index])
      const reply: [number,Uint8Array] = [c.responses[index].id, unhex(c.responses[index].hex)]
      return this.respond(type === 1810 ? [[26,new Uint8Array()],reply] : [reply])
    }
    // Independent public firmware fixture; pending ButtonAck replies keep their mapped IDs.
    const publicProtocol = type >= 1800 && type <= 1809
    if (this.publicOnly && [540, 542, 530, 532, 534].includes(type)) return this.respond([[3, new Uint8Array([8, 1])]])
    const replyType = (id: number) => publicProtocol ? ({ 541: 1801, 543: 1803, 531: 1805, 533: 1807, 535: 1809 } as Record<number, number>)[id] : id
    if (publicProtocol) type = ({ 1800: 540, 1802: 542, 1804: 530, 1806: 532, 1808: 534 } as Record<number, number>)[type]
    const images = this.keyImageOverride?[this.keyImageOverride]:fixtures.cases.base.signedTransaction.keyImages as string[]
    if (type === 27) { if (this.pending[0]?.[0] === 26 || (this.pending[0]?.[0] === 65001 || this.pending[0]?.[0] === 65003)) this.onReviewScreen?.(); return this.respond(this.pending) }
    if (type === 20) return this.respond([[3, new Uint8Array([8, 4])]])
    if (this.pinLocked && (type === 540 || type === 542 || type === 530 || (type === 65000 || type === 65002))) return this.respond([[18, new Uint8Array([8, 1])]])
    if (type === 540) {
      const minor = Number(parseFields(body).get(5)?.[0] ?? 0n)
      return this.respond([[replyType(541), lengthField(1, new TextEncoder().encode(minor ? SUBADDRESS : this.address))]])
    }
    if (type === 542) return this.respond([[26, new Uint8Array()], [replyType(543), concat([lengthField(1, this.watchViewKey.slice()), lengthField(2, new TextEncoder().encode(this.address))])]])
    if (type === 530) return this.respond([[26, new Uint8Array()], [replyType(531), new Uint8Array()]])
    if (type === 532) {
      // Key image per output: the fixture's for the fixture output, a derived one for synthetic outputs.
      const outKeys = parseFields(body).get(1)!.map(record => hex(parseFields(record as Uint8Array).get(1)![0] as Uint8Array))
      return this.respond([[replyType(533), concat(outKeys.map((outKey, i) => {
        const image = this.keyImageOverrides.get(outKey) ?? this.keyImageOverride ?? (outKey === fixtures.cases.base.adapterOutputs.outputs[0].out_key ? images[0] : hex(keccak_256(unhex(outKey))))
        const iv = new Uint8Array(12).fill(i + 1), plain = concat([unhex(image), new Uint8Array(64).fill(5)])
        return lengthField(1, concat([lengthField(1, iv), lengthField(3, chacha20poly1305(ENC_KEY, iv).encrypt(plain))]))
      }))]])
    }
    if (type === 534) return this.respond([[replyType(535), lengthField(1, ENC_KEY.slice())]])
    if (type === 65000 || type === 65002) {
      const screens: Array<[number, Uint8Array]> = Array.from({ length: this.reviewScreens }, () => [26, new Uint8Array()])
      // Each ButtonRequest waits for its own ButtonAck before the next message.
      return this.respond([...screens, [type === 65002 ? 65003 : 65001, concat([lengthField(1, this.signedBlob), lengthField(2, this.signedHash)])]])
    }
    this.respond([[3, new Uint8Array([8, 1])]])
  }
  async writeChunk(report: Uint8Array) {
    if (!this.partial) {
      const view = new DataView(report.buffer, report.byteOffset)
      this.partial = { type: view.getUint16(3), length: view.getUint32(5), data: [...report.subarray(9)] }
    } else this.partial.data.push(...report.subarray(1))
    if (this.partial.data.length >= this.partial.length) {
      const { type, length, data } = this.partial; this.partial = null
      if (this.streamHook) await this.streamHook(type)
      this.handle(type, Uint8Array.from(data.slice(0, length)))
    }
  }
  async readChunk() {
    const report = this.queue.shift()
    if (!report) throw new Error('Public fixture response exhausted')
    if (report[1] === 35 && report[2] === 35 && ((report[3] << 8) | report[4]) === 26) this.onButtonRequest?.()
    return report.slice()
  }
}

function bridge(options: { signing?: boolean; sendReady?: boolean; monitorReady?: boolean; pendingStore?: MoneroPendingStore; watchStore?: MoneroWatchStore; coreVerifier?: MoneroCoreVerifier } = {}) {
  const delegate = new Emulator()
  const calls: Record<string, any[]> = { imports: [], transfers: [], relays: [], refreshes: [], lookups: [] }
  // What the node says about a txid (/get_transactions + /is_key_image_spent).
  type Lookup = { state: 'pool' | 'mined' | 'unknown'; height?: number; keyImages: Array<'unspent' | 'spent' | 'pool'> } | Error
  let lookup: Lookup | ((n: number) => Lookup) = { state: 'unknown', keyImages: ['unspent'] }
  // The watch wallet as the sidecar reports it; tests edit it (new tx, node down, scanning).
  const wallet: Record<string, any> = { balanceAtomic: '7000000000000', unlockedBalanceAtomic: '7000000000000', walletHeight: 120, transactions: [],
    monitorReady: options.monitorReady !== false }
  const watch = () => { const { afterImport: _, ...reported } = structuredClone(wallet); return { network: 'mainnet', address: delegate.address, canSend: false, updatedAt: new Date().toISOString(), ...reported } }
  let draft = (_input: { address: string; amountAtomic: string }) => ({ feeAtomic: '20000000', amountAtomic: '2000000000000', plan: planOf('base') })
  let relayError: Error | null = null
  let transferError: Error | null = null
  let outputs = () => validateOutputs(structuredClone(fixtures.cases.base.adapterOutputs))
  const sidecar: MoneroWatchSidecar = {
    async startMoneroSidecar() {}, stopMoneroSidecar() {},
    async configureMoneroWatch() { return watch() },
    async getMoneroWalletStatus() { return watch() },
    isMoneroSendReady: () => options.sendReady !== false,
    async exportMoneroOutputs() { return outputs() },
    // Importing key images can reveal spends: the wallet then reports a lower balance.
    async importMoneroKeyImages(input) { calls.imports.push(input); if (wallet.afterImport) wallet.balanceAtomic = wallet.afterImport; return { height: 120, spentAtomic: '0', unspentAtomic: wallet.balanceAtomic } },
    async lookupMoneroTransaction(input) {
      calls.lookups.push(input)
      const next = typeof lookup === 'function' ? lookup(calls.lookups.length) : lookup
      if (next instanceof Error) throw next
      return structuredClone(next)
    },
    async createMoneroTransfer(input) { calls.transfers.push(input); if (transferError) throw transferError; return draft(input) },
    async relayMoneroTransaction(input) { calls.relays.push(input); if (relayError) throw relayError; return { relayed: true } },
    async refreshMoneroWatch() { calls.refreshes.push(true) },
  }
  const transport = { delegate, lockDuring: <T,>(operation: () => Promise<T>) => operation() }
  const state: { state: string; deviceId: string; activeTransport: string; isHiddenWallet: boolean; firmwareVersion: string; capabilities?: number[]; firmwareHash?: string } = { state: 'ready', deviceId: 'PUBLIC-EMULATOR', activeTransport: 'emulator', isHiddenWallet: false, firmwareVersion: '7.17.0' }
  const config: { enabled: boolean; offline: boolean; daemonUrl: string; restoreHeight: number } = { enabled: true, offline: false, daemonUrl: 'http://127.0.0.1:18081', restoreHeight: 0 }
  const engine = { isEmulator: true, wallet: { transport }, emuDelegate: delegate, currentSeedEthAddress: null as string | null, getDeviceState: () => ({ ...state }) }
  const confirmed: any[] = []
  const confirm = async (operation: () => Promise<any>, details: any) => {
    confirmed.push(details); delegate.onButtonRequest = () => {}
    try { return await operation() } finally { delegate.onButtonRequest = null }
  }
  const api = createMoneroVault({ engine, confirm, sidecar, signingEmulator: () => options.signing !== false,
    getConfig: () => ({ ...config }), pendingStore: options.pendingStore, watchStore: options.watchStore, coreVerifier: options.coreVerifier })
  return { api, delegate, calls, confirmed, engine, state, config, wallet,
    setDraft(next: typeof draft) { draft = next }, setRelayError(error: Error | null) { relayError = error },
    setTransferError(error: Error | null) { transferError = error }, setLookup(next: typeof lookup) { lookup = next }, setOutputs(next: typeof outputs) { outputs = next } }
}
const sentTypes = (b: ReturnType<typeof bridge>) => b.delegate.received.map(message => message.type)

describe('Desktop Monero send bridge', () => {
  test('connect, sync key images, prepare, confirm on the emulator, verify, relay', async () => {
    const b = bridge()
    await b.api.connect()
    expect(await b.api.getStatus()).toMatchObject({ canSend: false, keyImagesSynced: false, sendBlocked: 'key-images' })
    const synced = await b.api.syncKeyImages()
    expect(synced).toMatchObject({ canSend: true, keyImagesSynced: true, spendStateKnown: true })
    expect(synced.sendBlocked).toBeUndefined()
    expect(b.calls.imports).toEqual([{ offset: 0, signedKeyImages: [{ keyImage: fixtures.cases.base.signedTransaction.keyImages[0], signature: '05'.repeat(64) }] }])
    expect(sentTypes(b)).toEqual([540, 542, 27, 530, 27, 532, 534])

    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    expect(b.calls.transfers).toEqual([{ address: RECIPIENT, amountAtomic: '2000000000000', priority: 0 }])
    expect(review).toMatchObject({ recipient: RECIPIENT, amountAtomic: '2000000000000', feeAtomic: '20000000', changeAtomic: '4999980000000', totalAtomic: '2000020000000' })
    expect(review.prepareId).toMatch(/^[0-9a-f]{32}$/)

    const result = await b.api.send({ prepareId: review.prepareId })
    expect(result).toEqual({ txid: referenceHash('base') })
    const request = b.delegate.received.find(message => message.type === 65000)!
    const expected = planOf('base')
    expected.outputs.sort((a, b) => review.outputs.findIndex(o => o.address === a.address) - review.outputs.findIndex(o => o.address === b.address))
    expect(hex(request.body)).toBe(hex(signRequest(expected)))
    expect(sentTypes(b).slice(-4)).toEqual([65000, 27, 27, 27])
    expect(b.confirmed.at(-1)).toEqual({ operation: 'moneroSend', chain: 'Monero', to: RECIPIENT, value: '2.000000000000 XMR', fee: '0.000020000000 XMR' })
    expect(b.calls.relays).toEqual([{ txHex: fixtures.cases.base.signedTransaction.hex }])
    // Spent inputs changed: the next send needs a new key-image sync, and the review is single use.
    expect((await b.api.getStatus()).sendBlocked).toBe('key-images')
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('expired')
  })

  test('each gate explains itself and nothing reaches the device or wallet before it is met', async () => {
    const receiveOnly = bridge({ signing: false })
    await expect(receiveOnly.api.connect()).rejects.toThrow('signing (research) emulator')
    expect((await receiveOnly.api.getStatus()).sendBlocked).toBe('emulator')
    const noAdapter = bridge({ sendReady: false })
    await expect(noAdapter.api.connect()).rejects.toThrow('missing required Monero wallet tools')
    expect((await noAdapter.api.getStatus()).sendBlocked).toBe('adapter')
    await expect(noAdapter.api.prepareSend({ address: RECIPIENT, amountAtomic: '1' })).rejects.toThrow('missing required Monero wallet tools')
    expect(noAdapter.calls.transfers).toHaveLength(0)
    const scanning = bridge({ monitorReady: false })
    await scanning.api.connect()
    expect((await scanning.api.getStatus()).sendBlocked).toBe('syncing')
    const unsynced = bridge()
    await expect(unsynced.api.prepareSend({ address: RECIPIENT, amountAtomic: '1' })).rejects.toThrow('Connect the Monero watch wallet first')
    await unsynced.api.connect()
    await expect(unsynced.api.prepareSend({ address: RECIPIENT, amountAtomic: '1' })).rejects.toThrow('Sync key images')
    expect(unsynced.calls.transfers).toHaveLength(0)
  })

  test('malformed, integrated and self-addressed sends are refused before the wallet builds anything', async () => {
    const b = bridge()
    await b.api.connect(); await b.api.syncKeyImages()
    await expect(b.api.prepareSend({ address: '4' + '1'.repeat(94), amountAtomic: '1' })).rejects.toThrow('valid Monero mainnet address')
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '0' })).rejects.toThrow('positive')
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: 5 as any })).rejects.toThrow('positive')
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '18446744073709551616' })).rejects.toThrow('positive')
    await expect(b.api.prepareSend({ address: WALLET, amountAtomic: '1' })).rejects.toThrow("this wallet's own main address")
    expect(b.calls.transfers).toHaveLength(0)
  })

  test('a plan that differs from the request is refused and never signed', async () => {
    const b = bridge()
    await b.api.connect(); await b.api.syncKeyImages()
    b.setDraft(() => { const plan = planOf('base'); plan.outputs[0].address = SUBADDRESS; return { feeAtomic: '20000000', amountAtomic: '2000000000000', plan } })
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('does not match your request: recipient')
    b.setDraft(() => ({ feeAtomic: '1', amountAtomic: '2000000000000', plan: planOf('base') }))
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('fee')
    expect(sentTypes(b)).not.toContain(65000)
    await expect(b.api.send({ prepareId: 'ff'.repeat(16) })).rejects.toThrow('expired')
  })

  test('a signed transaction that does not verify, or a daemon refusal, is reported and not retried', async () => {
    const b = bridge()
    await b.api.connect(); await b.api.syncKeyImages()
    b.delegate.signedHash = new Uint8Array(32)
    let review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('does not match the reviewed plan')
    expect(b.calls.relays).toHaveLength(0)

    b.delegate.signedHash = unhex(referenceHash('base'))
    b.setRelayError(new Error('The daemon rejected the transaction: fee too low'))
    review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('fee too low')
    expect(b.calls.relays).toHaveLength(1)
    expect((await b.api.getStatus()).unrelayedTxid).toBeUndefined()
    b.setRelayError(new Error('ECONNRESET with DO-NOT-EXPOSE detail'))
    await b.api.syncKeyImages()
    review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow(`broadcast result is unknown for transaction ${referenceHash('base')}`)
  })

  test('an unknown broadcast outcome blocks new sends until the same bytes are re-broadcast', async () => {
    const b = bridge()
    await b.api.connect(); await b.api.syncKeyImages()
    b.setRelayError(new Error('The Monero daemon is unavailable'))
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')
    const status = await b.api.getStatus()
    expect(status.unrelayedTxid).toBe(referenceHash('base'))
    expect(status.canSend).toBe(false)
    expect(status.sendBlocked).toBe('unrelayed')
    await b.api.syncKeyImages()
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('retry broadcasting')
    const signs = sentTypes(b).filter(type => type === 65000).length
    b.setRelayError(null)
    expect(await b.api.retryRelay()).toEqual({ txid: referenceHash('base') })
    expect(b.calls.relays).toHaveLength(2)
    expect(b.calls.relays[1]).toEqual(b.calls.relays[0])
    expect(sentTypes(b).filter(type => type === 65000).length).toBe(signs)
    expect((await b.api.getStatus()).unrelayedTxid).toBeUndefined()
  })

  test('a fee above the cap or not below the payment is refused before signing', async () => {
    const b = bridge()
    await b.api.connect(); await b.api.syncKeyImages()
    b.setDraft(() => { const plan = planOf('base'); plan.feeAtomic = '6000000000'; return { feeAtomic: '6000000000', amountAtomic: '2000000000000', plan } })
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('fee')
    expect(sentTypes(b)).not.toContain(65000)
  })

  test('a device, seed or configuration change revokes synced key images and prepared sends', async () => {
    const b = bridge()
    await b.api.connect(); await b.api.syncKeyImages()
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    b.engine.currentSeedEthAddress = '0xother'
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow()
    expect(sentTypes(b)).not.toContain(65000)
    b.engine.currentSeedEthAddress = null
    expect((await b.api.getStatus()).keyImagesSynced).toBe(false)
  })
})

// ── Stability plan C2/C3: every balance state and send edge case, through the same bridge ──

const UNLOCKED = 7_000_000_000_000n, FEE = 20_000_000n
/** A wallet that behaves like wallet-rpc + the adapter for the one 7 XMR fixture output: fee 0.00002,
 *  "not enough" past the balance, and no plan at all for exactly zero change (the adapter refuses zero outputs). */
function walletDraft(input: { address: string; amountAtomic: string }) {
  const amount = BigInt(input.amountAtomic)
  if (amount + FEE > UNLOCKED) throw new Error('Not enough unlocked XMR for this amount and fee')
  if (amount + FEE === UNLOCKED) throw new Error('The watch wallet cannot build this transaction')
  const plan = planOf('base')
  plan.outputs[0] = { ...plan.outputs[0], address: input.address, amountAtomic: amount.toString() }
  plan.outputs[1] = { ...plan.outputs[1], amountAtomic: (UNLOCKED - amount - FEE).toString() }
  return { feeAtomic: FEE.toString(), amountAtomic: amount.toString(), plan }
}
async function ready(options: Parameters<typeof bridge>[0] = {}) {
  const b = bridge(options)
  b.setDraft(walletDraft)
  await b.api.connect(); await b.api.syncKeyImages()
  return b
}
const signs = (b: ReturnType<typeof bridge>) => sentTypes(b).filter(type => type === 65000).length

describe('C2: balance states', () => {
  test('scanning: no balance claim until the first scan finishes, progress from the node tip', async () => {
    const b = bridge()
    Object.assign(b.wallet, { walletHeight: 0, monitorReady: false, balanceAtomic: '0', unlockedBalanceAtomic: '0', daemonHeight: 3_000_000 })
    expect((await b.api.connect()).syncState).toBe('scanning')
    Object.assign(b.wallet, { walletHeight: 2_000_000 })
    expect(await b.api.getStatus()).toMatchObject({ syncState: 'scanning', walletHeight: 2_000_000, daemonHeight: 3_000_000, restoreHeight: 0, error: undefined })
  })

  test('node down: the last balance stays, labelled unreachable (worker error and worker gone)', async () => {
    const b = bridge()
    await b.api.connect()
    b.wallet.monitorReady = false; b.wallet.error = 'The Monero node could not be reached; showing the last wallet update'
    expect(await b.api.getStatus()).toMatchObject({ syncState: 'unreachable', balanceAtomic: '7000000000000', available: true })
    // The worker itself gone: the vault keeps its last good status, labelled.
    Object.defineProperty(b.wallet, 'walletHeight', { enumerable: true, get() { throw new Error('worker gone') } })
    expect(await b.api.getStatus()).toMatchObject({ syncState: 'unreachable', balanceAtomic: '7000000000000', walletHeight: 120,
      error: 'The Monero monitor is temporarily unavailable; showing the last wallet update' })
  })

  test('a long scan whose refresh timed out is scanning, not a node failure', async () => {
    const b = bridge()
    await b.api.connect()
    Object.assign(b.wallet, { monitorReady: false, error: 'The Monero watch wallet is still scanning' })
    expect(await b.api.getStatus()).toMatchObject({ syncState: 'scanning', error: undefined })
  })

  test('received but not verified spendable until key images are synced', async () => {
    const b = bridge()
    expect(await b.api.connect()).toMatchObject({ syncState: 'ready', spendStateKnown: false, keyImagesSynced: false })
    expect(await b.api.syncKeyImages()).toMatchObject({ spendStateKnown: true, keyImagesSynced: true })
  })
})

describe('C3: send edge cases', () => {
  test('more than the unlocked balance is refused before the wallet builds anything, naming the locked part', async () => {
    const b = bridge(); b.setDraft(walletDraft)
    b.wallet.balanceAtomic = '9000000000000'
    await b.api.connect(); await b.api.syncKeyImages()
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '8000000000000' })).rejects.toThrow('more than your unlocked balance (7.000000000000 XMR); 2.000000000000 XMR is still locked')
    expect(b.calls.transfers).toHaveLength(0)
  })

  test('a legacy wallet builder refusal of zero change is surfaced; an insufficient fee reserve is short', async () => {
    const b = await ready()
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: (UNLOCKED - FEE).toString() })).rejects.toThrow('The watch wallet cannot build this transaction')
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: (UNLOCKED - 1n).toString() })).rejects.toThrow('Not enough unlocked XMR for this amount plus the 0.000020000000 XMR network fee')
    expect(signs(b)).toBe(0)
  })

  test('Max sends the whole unlocked balance minus the fee, keeping one atomic unit of change, and signs it', async () => {
    const b = await ready()
    const review = await b.api.prepareSend({ address: RECIPIENT, max: true })
    expect(review).toMatchObject({ max: true, amountAtomic: (UNLOCKED - FEE - 1n).toString(), feeAtomic: FEE.toString(), changeAtomic: '1' })
    expect(await b.api.send({ prepareId: review.prepareId })).toEqual({ txid: referenceHash('base') })
    expect(b.calls.relays).toHaveLength(1)
  })

  test('dust: an amount not above the fee is refused with the fee named, nothing signed', async () => {
    const b = await ready()
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '1' })).rejects.toThrow('The network fee (0.000020000000 XMR) is not less than this amount')
    expect(signs(b)).toBe(0)
  })

  test('a fee above the 0.005 XMR cap is refused, naming the cap', async () => {
    const b = await ready()
    b.setDraft(input => { const d = walletDraft(input); d.plan.feeAtomic = d.feeAtomic = '6000000000'; d.plan.outputs[1].amountAtomic = (UNLOCKED - BigInt(input.amountAtomic) - 6_000_000_000n).toString(); return d })
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('above the 0.005000000000 XMR safety cap')
    expect(signs(b)).toBe(0)
  })

  test('node down before signing: the prepare fails with the node named and nothing reaches the device', async () => {
    const b = await ready()
    b.setTransferError(new Error('The Monero daemon is unavailable'))
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('The Monero daemon is unavailable')
    expect(signs(b)).toBe(0)
  })

  test('device switched while KeepKey shows the review: the signed bytes are dropped, never relayed or kept', async () => {
    const b = await ready()
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    b.delegate.onReviewScreen = () => { b.state.deviceId = 'OTHER-DEVICE' }
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('changed')
    expect(b.calls.relays).toHaveLength(0)
    b.state.deviceId = 'PUBLIC-EMULATOR'
    expect((await b.api.getStatus()).unrelayedTxid).toBeUndefined()
  })

  test('Monero turned off between review and confirm, or during signing: nothing is signed or relayed', async () => {
    const b = await ready()
    let review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    b.config.enabled = false
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('Monero is disabled in settings')
    expect(signs(b)).toBe(0)
    b.config.enabled = true
    await b.api.connect(); await b.api.syncKeyImages()
    review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    b.delegate.onReviewScreen = () => { b.config.enabled = false }
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow()
    expect(b.calls.relays).toHaveLength(0)
  })

  test('key images go out of date when XMR arrives after the sync; a plan spending an unsynced output is refused', async () => {
    const b = await ready()
    b.wallet.transactions = [{ txid: 'cd'.repeat(32), amountAtomic: '1000000000000', confirmations: 0, locked: true, height: 0, type: 'pool' }]
    expect(await b.api.getStatus()).toMatchObject({ canSend: false, sendBlocked: 'key-images', keyImagesStale: true, spendStateKnown: false })
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('New XMR arrived since the last key-image sync')
    expect((await b.api.syncKeyImages()).canSend).toBe(true)
    b.setDraft(input => { const d = walletDraft(input); d.plan.inputs[0].ring[d.plan.inputs[0].realMember].publicKey = 'ee'.repeat(32); return d })
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('New XMR arrived since the last key-image sync')
    expect(signs(b)).toBe(0)
  })

  test('more than 64 outputs sync in sessions of 64, each imported at its offset', async () => {
    const b = bridge()
    const base = validateOutputs(structuredClone(fixtures.cases.base.adapterOutputs))[0]
    const many = Array.from({ length: 130 }, (_, i) => i === 0 ? base : { ...base, transferIndex: i, outKey: hex(keccak_256(new Uint8Array([i, 1]))), globalIndex: String(1000 + i) })
    b.setOutputs(() => many)
    await b.api.connect()
    expect((await b.api.syncKeyImages()).keyImagesSynced).toBe(true)
    expect(sentTypes(b).filter(type => type === 530)).toHaveLength(3)
    const counts = b.delegate.received.filter(m => m.type === 530).map(m => Number(parseFields(m.body).get(1)![0]))
    expect(counts).toEqual([64, 64, 2])
    expect(b.calls.imports.map(i => [i.offset, i.signedKeyImages.length])).toEqual([[0, 64], [64, 64], [128, 2]])
    expect(b.calls.imports[0].signedKeyImages[0].keyImage).toBe(fixtures.cases.base.signedTransaction.keyImages[0])
  })

  test('subaddress recipients are prepared; integrated addresses are refused with the reason', async () => {
    const b = await ready()
    expect((await b.api.prepareSend({ address: SUBADDRESS, amountAtomic: '2000000000000' })).outputs.find(o => o.role === 'recipient')).toEqual({ role: 'recipient', address: SUBADDRESS, amountAtomic: '2000000000000' })
    const integrated = '4LL9oSLmtpccfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2bYXZKKQePHES9khPK'
    expect(moneroAddressKind(integrated)).toBe('integrated')
    await expect(b.api.prepareSend({ address: integrated, amountAtomic: '1' })).rejects.toThrow('Integrated addresses are not supported')
    expect(b.calls.transfers.every(t => t.address !== integrated)).toBe(true)
  })

  test('my own main address is refused with the way to move funds; my own subaddress comes from the device', async () => {
    const b = await ready()
    await expect(b.api.prepareSend({ address: WALLET, amountAtomic: '2000000000000' })).rejects.toThrow('send it to one of its subaddresses')
    expect(await b.api.getAddress({ showDisplay: false, minor: 1 })).toEqual({ address: SUBADDRESS, network: 'mainnet', displayed: false, minor: 1 })
    await expect(b.api.getAddress({ showDisplay: false, minor: 200 })).rejects.toThrow('from 0 to 199')
    expect((await b.api.prepareSend({ address: SUBADDRESS, amountAtomic: '2000000000000' })).recipient).toBe(SUBADDRESS)
  })

  test('a PIN-locked wallet cancels the request and says to unlock; nothing is signed', async () => {
    const b = await ready()
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    b.delegate.pinLocked = true
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('Unlock the KeepKey wallet first')
    expect(sentTypes(b).at(-1)).toBe(20)
    expect(b.calls.relays).toHaveLength(0)
    await expect(b.api.connect()).rejects.toThrow('Unlock the KeepKey wallet first')
  })
})

describe('C3: the unknown-broadcast guard survives an app restart', () => {
  const store = () => { const dir = mkdtempSync(join(tmpdir(), 'kk-monero-pending-')); return { dir, store: createFilePendingStore(dir) } }

  test('a restarted app restores the block from an owner-only file and re-broadcasts the same bytes', async () => {
    const { dir, store: pendingStore } = store()
    const first = await ready({ pendingStore })
    first.setRelayError(new Error('The Monero daemon is unavailable'))
    const review = await first.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(first.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')
    const file = join(dir, 'monero-pending-broadcast.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)

    // "Restart": a new bridge (new vault, same file); nothing in memory carries over.
    const second = bridge({ pendingStore: createFilePendingStore(dir) })
    second.setDraft(walletDraft)
    expect((await second.api.getStatus()).unrelayedTxid).toBe(referenceHash('base'))
    await second.api.connect(); await second.api.syncKeyImages()
    expect(await second.api.getStatus()).toMatchObject({ canSend: false, sendBlocked: 'unrelayed', unrelayedTxid: referenceHash('base') })
    await expect(second.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('retry broadcasting')
    expect(await second.api.retryRelay()).toEqual({ txid: referenceHash('base') })
    expect(second.calls.relays).toEqual([{ txHex: fixtures.cases.base.signedTransaction.hex }])
    expect(signs(second)).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect((await second.api.getStatus()).canSend).toBe(true)
  })

  test('hidden wallets are unavailable without erasing the original owner pending block', async () => {
    const { store: pendingStore } = store()
    const b = await ready({ pendingStore })
    b.setRelayError(new Error('ETIMEDOUT'))
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')
    b.state.isHiddenWallet = true; b.engine.currentSeedEthAddress = '0xpassphrase'; b.delegate.address = RECIPIENT
    await expect(b.api.connect()).rejects.toThrow(MONERO_STANDARD_WALLET_REQUIRED)
    const hidden = await b.api.getStatus()
    expect(hidden.available).toBe(false)
    expect(hidden.address).toBe('')
    expect(hidden.unrelayedTxid).toBeUndefined()
    b.state.isHiddenWallet = false; b.engine.currentSeedEthAddress = null; b.delegate.address = WALLET
    expect((await b.api.connect()).sendBlocked).toBe('unrelayed')
  })

  test('a record whose bytes do not hash to its txid is not restored', () => {
    const { dir } = store()
    writeFileSync(join(dir, 'monero-pending-broadcast.json'), JSON.stringify({ version: 1, records: [
      { wallet: `PUBLIC-EMULATOR:${WALLET}`, txid: 'ab'.repeat(32), txHex: fixtures.cases.base.signedTransaction.hex, createdAt: new Date().toISOString() }] }))
    expect(createFilePendingStore(dir).load()).toEqual([])
    writeFileSync(join(dir, 'monero-pending-broadcast.json'), 'not json')
    expect(createFilePendingStore(dir).load()).toEqual([])
  })

  test('past the 16-record cap the newest records are kept', () => {
    const { dir } = store()
    const record = { wallet: `PUBLIC-EMULATOR:${WALLET}`, txid: referenceHash('base'), txHex: fixtures.cases.base.signedTransaction.hex }
    const records = Array.from({ length: 20 }, (_, i) => ({ ...record, wallet: `DEVICE-${i}:${WALLET}`, createdAt: new Date(Date.UTC(2026, 10, 1, i)).toISOString() }))
    createFilePendingStore(dir).save(records)
    expect(createFilePendingStore(dir).load().map(r => r.wallet)).toEqual(records.slice(4).map(r => r.wallet))
  })

  test('if the record cannot be saved, the signed transaction is not broadcast', async () => {
    const b = await ready({ pendingStore: { load: () => [], save: () => { throw new Error('disk full') } } })
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('could not be saved for recovery, so it was not broadcast')
    expect(b.calls.relays).toHaveLength(0)
    expect((await b.api.getStatus()).unrelayedTxid).toBeUndefined()
  })
})

describe('C4: the scan start', () => {
  test('the scan start in use is reported before and after connecting', async () => {
    const b = bridge()
    b.config.restoreHeight = 3_294_960
    expect((await b.api.getStatus()).restoreHeight).toBe(3_294_960)
    expect((await b.api.connect()).restoreHeight).toBe(3_294_960)
  })
})

describe('review fixes: node silence, Max fee drift, stale baseline', () => {
  test('a node that stops answering after the first sync shows the last balance as unreachable, not syncing', async () => {
    const b = await ready()
    // What the worker's node probe writes when /get_height stops answering mid-session.
    Object.assign(b.wallet, { monitorReady: false, error: 'The Monero node could not be reached; showing the last wallet update', daemonHeight: 3_300_000 })
    expect(await b.api.getStatus()).toMatchObject({ syncState: 'unreachable', balanceAtomic: '7000000000000', canSend: false, sendBlocked: 'syncing' })
  })

  test('Max when the fee grows between the estimate and the plan still leaves exactly one atomic unit', async () => {
    const b = await ready()
    let call = 0
    b.setDraft(input => {
      const fee = ++call === 1 ? FEE : FEE * 2n  // the probe saw FEE; the real plan costs twice that
      const amount = BigInt(input.amountAtomic)
      if (amount + fee > UNLOCKED) throw new Error('Not enough unlocked XMR for this amount and fee')
      const plan = planOf('base')
      plan.feeAtomic = fee.toString()
      plan.outputs[0] = { ...plan.outputs[0], address: input.address, amountAtomic: amount.toString() }
      plan.outputs[1] = { ...plan.outputs[1], amountAtomic: (UNLOCKED - amount - fee).toString() }
      return { feeAtomic: fee.toString(), amountAtomic: amount.toString(), plan }
    })
    const review = await b.api.prepareSend({ address: RECIPIENT, max: true })
    expect(review).toMatchObject({ amountAtomic: (UNLOCKED - FEE * 2n - 1n).toString(), feeAtomic: (FEE * 2n).toString(), changeAtomic: '1' })
  })

  test('key images go stale against the post-import balance, not the higher pre-import one', async () => {
    const b = bridge(); b.setDraft(walletDraft)
    b.wallet.balanceAtomic = '9000000000000'
    await b.api.connect()
    // The import finds 2 XMR already spent elsewhere: the wallet now has 7 XMR unspent.
    b.wallet.afterImport = '7000000000000'
    await b.api.syncKeyImages()
    expect((await b.api.getStatus()).keyImagesStale).toBeUndefined()
    // A new 1 XMR deposit (balance back to 8, still under the old 9): stale.
    b.wallet.balanceAtomic = '8000000000000'
    expect((await b.api.getStatus()).keyImagesStale).toBe(true)
  })

  test('with more than 64 outputs the cumulative import total is used once, not added per session', async () => {
    const b = bridge()
    const base = validateOutputs(structuredClone(fixtures.cases.base.adapterOutputs))[0]
    b.setOutputs(() => Array.from({ length: 130 }, (_, i) => i === 0 ? base : { ...base, transferIndex: i, outKey: hex(keccak_256(new Uint8Array([i, 2]))), globalIndex: String(2000 + i) }))
    await b.api.connect(); await b.api.syncKeyImages()
    // wallet2 answers every session with the running total (7 XMR); summing would make 21 XMR the baseline.
    expect(b.calls.imports).toHaveLength(3)
    expect((await b.api.getStatus()).keyImagesStale).toBeUndefined()
    b.wallet.balanceAtomic = '8000000000000'
    expect((await b.api.getStatus()).keyImagesStale).toBe(true)
  })
})

describe('C3: a pending broadcast is settled by asking the node, never left blocking forever', () => {
  const pendingSend = async (relayError = new Error('The daemon accepted the transaction but did not relay it')) => {
    const b = await ready()
    b.setRelayError(relayError)
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    return { b, sending: b.api.send({ prepareId: review.prepareId }) }
  }
  const keyImage = fixtures.cases.base.signedTransaction.keyImages[0]

  test('an unknown outcome the node already has in its pool is a sent payment', async () => {
    const { b, sending } = await pendingSend()
    b.setLookup({ state: 'pool', keyImages: ['pool'] })
    expect(await sending).toEqual({ txid: referenceHash('base') })
    expect(b.calls.lookups[0]).toEqual({ txid: referenceHash('base'), keyImages: [keyImage] })
    expect((await b.api.getStatus()).unrelayedTxid).toBeUndefined()
  })

  test('lost acceptance on node A survives node B retry refusal, restart and guarded abandonment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kk-monero-retry-'))
    const store = createFilePendingStore(dir)
    const first = await ready({ pendingStore: store })
    first.config.daemonUrl = 'https://node-a.example:18081'
    // Changing the node requires reconnecting and syncing again.
    await first.api.connect(); await first.api.syncKeyImages()
    first.setRelayError(new Error('ETIMEDOUT'))
    const review = await first.api.prepareSend({address:RECIPIENT,amountAtomic:'2000000000000'})
    await expect(first.api.send({prepareId:review.prepareId})).rejects.toThrow('broadcast result is unknown')
    const original = store.load()[0]
    const second = bridge({ pendingStore: store })
    second.config.daemonUrl = 'https://node-b.example:18081'
    await second.api.connect()
    second.setRelayError(new Error('The daemon rejected the transaction: fee too low'))
    await expect(second.api.retryRelay()).rejects.toThrow('fee too low')
    expect(second.api.pendingCount()).toBe(1)
    expect(store.load()).toEqual([original])
    expect(second.calls.relays).toEqual([{txHex:original.txHex}])
    expect((await second.api.getStatus()).sendBlocked).toBe('unrelayed')
    const restarted = bridge({pendingStore:createFilePendingStore(dir)})
    await restarted.api.connect()
    expect(restarted.api.pendingCount()).toBe(1)
    await restarted.api.discardPending({confirm:true})
    expect(store.load()).toEqual([])
    expect(store.loadGuards!()[0]).toMatchObject({txid:original.txid,keyImages:[keyImage]})
    const abandoned = bridge({pendingStore:createFilePendingStore(dir)})
    expect((await abandoned.api.connect()).discardedTxid).toBe(original.txid)
  })

  test('a retry that gets "Not relayed" (the node already has it) looks it up and settles as sent', async () => {
    const { b, sending } = await pendingSend(new Error('ETIMEDOUT'))
    await expect(sending).rejects.toThrow('broadcast result is unknown')
    // The first reply was lost; the node received it and mined it. Re-sending answers "Not relayed".
    b.setRelayError(new Error('The daemon accepted the transaction but did not relay it'))
    b.setLookup(n => n <= 1 ? { state: 'unknown', keyImages: ['unspent'] } : { state: 'mined', height: 81, keyImages: ['spent'] })
    expect(await b.api.retryRelay()).toEqual({ txid: referenceHash('base') })
    expect((await b.api.getStatus()).sendBlocked).not.toBe('unrelayed')
  })

  test('after a restart, a pending tx the node has mined is settled on connect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kk-monero-pending-'))
    const first = await ready({ pendingStore: createFilePendingStore(dir) })
    first.setRelayError(new Error('ETIMEDOUT'))
    const review = await first.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(first.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')
    const second = bridge({ pendingStore: createFilePendingStore(dir) })
    second.setLookup({ state: 'mined', height: 81, keyImages: ['spent'] })
    expect((await second.api.connect()).unrelayedTxid).toBeUndefined()
    expect(existsSync(join(dir, 'monero-pending-broadcast.json'))).toBe(false)
  })

  test('"double spend": ours in a block is sent; spent on chain by another tx is settled as never sendable', async () => {
    let { b, sending } = await pendingSend(new Error('The daemon rejected the transaction: double spend'))
    b.setLookup({ state: 'mined', height: 90, keyImages: ['spent'] })
    expect(await sending).toEqual({ txid: referenceHash('base') })
    ;({ b, sending } = await pendingSend(new Error('The daemon rejected the transaction: double spend')))
    b.setLookup({ state: 'unknown', keyImages: ['spent'] })
    await expect(sending).rejects.toThrow('spent by a different transaction, so it can never be sent')
    expect((await b.api.getStatus()).unrelayedTxid).toBeUndefined()
  })

  test('the node unreachable for the lookup keeps the block; unknown with unspent inputs offers discard', async () => {
    const { b, sending } = await pendingSend()
    b.setLookup(new Error('The Monero daemon is unavailable'))
    await expect(sending).rejects.toThrow('broadcast result is unknown')
    expect(await b.api.getStatus()).toMatchObject({ sendBlocked: 'unrelayed', unrelayedTxid: referenceHash('base') })
    expect((await b.api.getStatus()).unrelayedCheck).toBeUndefined()
    await expect(b.api.discardPending({ confirm: true })).rejects.toThrow('could not be asked')
    b.setLookup({ state: 'unknown', keyImages: ['unspent'] })
    await expect(b.api.retryRelay()).rejects.toThrow('broadcast result is unknown')
    expect((await b.api.getStatus()).unrelayedCheck).toMatchObject({ state: 'unknown', discardable: true })
  })

  test('discard needs confirmation, and only when the node has neither the tx nor its inputs spent', async () => {
    const { b, sending } = await pendingSend()
    b.setLookup({ state: 'unknown', keyImages: ['pool'] })
    await expect(sending).rejects.toThrow('broadcast result is unknown')
    await expect(b.api.discardPending({})).rejects.toThrow('Confirm discarding')
    await expect(b.api.discardPending({ confirm: true })).rejects.toThrow("spent in the node's pool by another transaction")
    b.setLookup({ state: 'pool', keyImages: ['pool'] })
    expect(await b.api.discardPending({ confirm: true })).toEqual({ outcome: 'sent', txid: referenceHash('base') })
    const again = await pendingSend()
    again.b.setLookup({ state: 'unknown', keyImages: ['unspent'] })
    await expect(again.sending).rejects.toThrow('broadcast result is unknown')
    expect(await again.b.api.discardPending({ confirm: true })).toEqual({ outcome: 'discarded', txid: referenceHash('base') })
    expect((await again.b.api.getStatus()).sendBlocked).not.toBe('unrelayed')
    expect(signs(again.b)).toBe(1)
  })
})

describe('discard guard: a discarded tx that another node could still mine', () => {
  const base = () => validateOutputs(structuredClone(fixtures.cases.base.adapterOutputs))[0]
  const otherOutKey = hex(keccak_256(new Uint8Array([7, 7])))
  /** Two owned 7 XMR outputs; the discarded fixture tx spent the first. `useOther` builds plans from the second. */
  async function discarded(pendingStore?: MoneroPendingStore) {
    const b = bridge({ pendingStore })
    b.setOutputs(() => [base(), { ...base(), transferIndex: 1, outKey: otherOutKey, globalIndex: '4242' }])
    b.setDraft(walletDraft)
    await b.api.connect(); await b.api.syncKeyImages()
    b.setRelayError(new Error('ETIMEDOUT'))
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')
    b.setLookup({ state: 'unknown', keyImages: ['unspent'] })
    expect((await b.api.discardPending({ confirm: true })).outcome).toBe('discarded')
    b.setRelayError(null)
    await b.api.syncKeyImages()
    return b
  }
  const useOther = (b: ReturnType<typeof bridge>) => b.setDraft(input => { const d = walletDraft(input); d.plan.inputs[0].ring[d.plan.inputs[0].realMember].publicKey = otherOutKey; return d })

  test('the record names the node the relay went to; a check through another node says which answered', async () => {
    const b = await ready()
    b.setRelayError(new Error('ETIMEDOUT'))
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')
    expect((await b.api.getStatus()).unrelayedCheck).toMatchObject({ relayNode: 'http://127.0.0.1:18081', checkedNode: 'http://127.0.0.1:18081' })
    b.config.daemonUrl = 'http://localhost:18089'
    await b.api.connect()
    expect((await b.api.getStatus()).unrelayedCheck).toMatchObject({ relayNode: 'http://127.0.0.1:18081', checkedNode: 'http://localhost:18089' })
  })

  test('after a discard, a send using other inputs is refused; one reusing an input of the discarded tx is allowed', async () => {
    const b = await discarded()
    expect((await b.api.getStatus()).discardedTxid).toBe(referenceHash('base'))
    useOther(b)
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('could still be mined from another node')
    b.setDraft(walletDraft)
    expect((await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).recipient).toBe(RECIPIENT)
  })

  test('once its inputs are spent on chain the guard lifts; if the node now has the tx, the user is told it was sent', async () => {
    const b = await discarded()
    useOther(b)
    b.setLookup({ state: 'unknown', keyImages: ['spent'] })
    expect((await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).recipient).toBe(RECIPIENT)
    expect((await b.api.getStatus()).discardedTxid).toBeUndefined()
    const again = await discarded()
    again.setLookup({ state: 'mined', height: 99, keyImages: ['spent'] })
    await expect(again.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('was sent after all: the node has it in a block')
    expect((await again.api.getStatus()).discardedTxid).toBeUndefined()
  })

  test('the node unreachable: nothing new is built while a discarded tx is unresolved', async () => {
    const b = await discarded()
    b.setLookup(new Error('The Monero daemon is unavailable'))
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('could not be checked with the node')
    expect(b.calls.transfers.filter(t => t.amountAtomic === '2000000000000')).toHaveLength(1)
  })

  test('the guard survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kk-monero-pending-'))
    await discarded(createFilePendingStore(dir))
    expect(statSync(join(dir, 'monero-discarded-broadcast.json')).mode & 0o777).toBe(0o600)
    const next = bridge({ pendingStore: createFilePendingStore(dir) })
    next.setOutputs(() => [base(), { ...base(), transferIndex: 1, outKey: otherOutKey, globalIndex: '4242' }])
    await next.api.connect(); await next.api.syncKeyImages()
    useOther(next)
    await expect(next.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('could still be mined from another node')
  })
})


test('saved image proofs recheck known outputs after reconnect without hardware; changed outputs need fresh approval',async()=>{
 const db=new Database(':memory:')
 const store=createMoneroWatchStore({database:()=>db,profile:'test',key:async()=>new Uint8Array(32).fill(9)})
 const b=bridge({watchStore:store})
 b.engine.currentSeedEthAddress='0x'+'a'.repeat(40)
 try {
  await b.api.connect();await b.api.syncKeyImages()
  expect(sentTypes(b)).toContain(530)
  b.api.invalidate();await b.api.connect();b.delegate.received.length=0;b.confirmed.length=0
  expect((await b.api.syncKeyImages()).spendStateKnown).toBe(true)
  expect(sentTypes(b)).not.toContain(530)
  expect(b.confirmed).toHaveLength(0)
  expect(b.calls.imports).toHaveLength(2)
  b.setOutputs(()=>validateOutputs(structuredClone(fixtures.cases.base.adapterOutputs)).map(o=>({...o,amountAtomic:'1'})))
  await b.api.syncKeyImages()
  expect(sentTypes(b)).toContain(530)
  expect(b.calls.transfers).toHaveLength(0)
  expect(b.calls.relays).toHaveLength(0)
 } finally {db.close()}
})


// The stream envelopes below are reconstructed from unchanged firmware Core vectors.
function streamBridge(verify = true, pendingStore?: MoneroPendingStore, fixture = streamFixtures.cases[0], nativeVerifier?: MoneroCoreVerifier) {
 let verified = 0, disposed = 0
 const coreVerifier: MoneroCoreVerifier = { available: () => true, prepare: actual => {
  expect(actual).toEqual(fixture.plan as MoneroPlan)
  const native = nativeVerifier?.prepare(actual)
  return { verify: blob => { verified++; expect(hex(blob)).toBe(fixture.transactionHex); return native ? native.verify(blob) : verify }, dispose: () => { disposed++; native?.dispose() } }
 }}
 const b = bridge({ coreVerifier, pendingStore }), c = structuredClone(fixture), p = c.plan
 b.engine.isEmulator = false; b.state.activeTransport = 'hid'; b.state.capabilities = [31]
 b.delegate.streamFixture = c; b.delegate.address = streamFixtures.cases[0].plan.outputs.find(o => o.isChange)!.address
 b.delegate.watchViewKey = unhex('84b0087a63854856686f80596a5a1a6090795b4d1311139173262170d7e7180f')
 const signedInputs = parseSignedTransaction(unhex(c.transactionHex)).inputs
 for (const input of p.inputs) {
  const image = signedInputs.find(signed => signed.indices.every((v,i) => v === BigInt(input.ring[i].globalIndex)))!
  b.delegate.keyImageOverrides.set(input.ring[input.realMember].publicKey, image.keyImage)
 }
 b.wallet.balanceAtomic = p.inputs.reduce((n,i) => n + BigInt(i.amountAtomic),0n).toString()
 b.wallet.unlockedBalanceAtomic = b.wallet.balanceAtomic
 b.setOutputs(() => p.inputs.map((i,index) => ({transferIndex:index,amountAtomic:i.amountAtomic,globalIndex:i.ring[i.realMember].globalIndex,outKey:i.ring[i.realMember].publicKey,txPublicKey:i.txPublicKey,additionalTxPublicKeys:i.additionalTxPublicKeys,outputIndex:i.outputIndex,subaddressMajor:i.subaddressMajor,subaddressMinor:i.subaddressMinor})))
 b.setDraft(() => ({ feeAtomic:p.feeAtomic, amountAtomic:p.outputs.find(o => !o.isChange)!.amountAtomic, plan:structuredClone(p) as MoneroPlan }))
 return { ...b, c, p, coreVerifier, counts: () => ({verified,disposed}) }
}
async function prepareStream(b: ReturnType<typeof streamBridge>) {
 await b.api.connect(); await b.api.syncKeyImages()
 const output=b.p.outputs.find(o=>!o.isChange)!
 // Public replay vectors have one fixed output order. Prepare until that order is selected.
 for (let attempt = 0; attempt < 128; attempt++) {
  const review = await b.api.prepareSend({address:output.address,amountAtomic:output.amountAtomic})
  if (review.outputs[0].address === b.p.outputs[0].address) return review
 }
 throw Error('fixture output order never selected')
}

test('capability hardware streams 1810..1825 and verifies before relay without an emulator wrapper',async()=>{
 const b=streamBridge(); b.state.firmwareVersion='0.0.0'; b.state.firmwareHash='unrecognized'
 const review=await prepareStream(b)
 let proving: string|undefined
 b.delegate.streamHook=async type=>{ if(type===1818 && b.delegate.streamPosition===5) proving=(await b.api.getStatus()).signingPhase }
 await b.api.send({prepareId:review.prepareId})
 expect(sentTypes(b)).toContain(1810); expect(sentTypes(b)).toContain(1824)
 expect(sentTypes(b)).not.toContain(65002); expect(sentTypes(b)).not.toContain(65000)
 expect(sentTypes(b).filter(id=>id>=1800&&id<=1809)).toEqual([1800,1802,1804,1806,1808])
 expect(b.counts()).toEqual({verified:1,disposed:1}); expect(b.confirmed).toHaveLength(0)
 expect(b.calls.relays).toHaveLength(1); expect(proving).toBe('proving')
 expect((await b.api.getStatus()).signingPhase).toBeUndefined()
})

test('Core verification failure prevents persistence and relay',async()=>{
 const b=streamBridge(false),review=await prepareStream(b)
 await expect(b.api.send({prepareId:review.prepareId})).rejects.toThrow('independent Core')
 expect(b.calls.relays).toHaveLength(0);expect(b.api.pendingCount()).toBe(0)
 expect(b.counts()).toEqual({verified:1,disposed:1})
 expect((await b.api.getStatus()).signingPhase).toBeUndefined()
})

test('a research firmware hash alone cannot enable public hardware signing',async()=>{
 const b=bridge();b.engine.isEmulator=false;b.state.activeTransport='hid'
 b.state.firmwareHash='123af6de3b5ddbc1eeb94568825d1bb8107079bc9100ac67f9f6162ca34e2f83'
 await expect(b.api.connect()).rejects.toThrow('hardware signing')
 expect(sentTypes(b)).toEqual([]);expect(b.calls.transfers).toHaveLength(0)
 expect(b.calls.relays).toHaveLength(0)
})

test('removing the capability after review invalidates the send before device I/O',async()=>{
 const b=streamBridge(), review=await prepareStream(b), before=sentTypes(b).length
 b.state.capabilities=[]
 await expect(b.api.send({prepareId:review.prepareId})).rejects.toThrow('changed')
 expect(sentTypes(b).length).toBe(before);expect(b.calls.relays).toHaveLength(0)
})


test('a streamed prefix mismatch ends the session and never persists or relays',async()=>{
 const b=streamBridge(), review=await prepareStream(b)
 const ack=b.c.responses.find(r=>r.id===1821)!, bytes=unhex(ack.hex)
 bytesField(parseFields(bytes),2)[0]^=1;ack.hex=hex(bytes)
 await expect(b.api.send({prepareId:review.prepareId})).rejects.toThrow('prefix hash')
 expect(sentTypes(b)).not.toContain(1822);expect(sentTypes(b)).not.toContain(1824)
 expect(sentTypes(b).at(-1)).toBe(20)
 expect(b.calls.relays).toHaveLength(0);expect(b.api.pendingCount()).toBe(0)
 expect(b.counts()).toEqual({verified:0,disposed:1})
})

test('streamed plans outside output or ring limits fail prepare before device review',async()=>{
 for(const badShape of ['outputs','ring']) {
  const b=streamBridge()
  await b.api.connect();await b.api.syncKeyImages()
  const plan=structuredClone(b.p) as MoneroPlan,recipient=plan.outputs.find(o=>!o.isChange)!
  if(badShape==='outputs')plan.outputs.push({...recipient})
  else plan.inputs[0].ring.pop()
  b.setDraft(()=>({feeAtomic:plan.feeAtomic,amountAtomic:recipient.amountAtomic,plan}))
  const before=sentTypes(b).length
  await expect(b.api.prepareSend({address:recipient.address,amountAtomic:recipient.amountAtomic})).rejects.toThrow(badShape==='outputs'?'exactly two':'ring size of 16')
  expect(sentTypes(b).length).toBe(before);expect(b.calls.relays).toHaveLength(0)
 }
})

test('unqualified public firmware never offers a receive-only onboarding path', async () => {
  const b = bridge(); b.engine.isEmulator = false; b.state.activeTransport = 'hid'; b.delegate.publicOnly = true
  b.state.firmwareHash = 'a0275ca76568ace103cbb2daa069f76b0d8d7b5005a3419548a578018eda1808'
  await expect(b.api.connect()).rejects.toThrow('hardware signing')
  expect(sentTypes(b)).toEqual([])
  expect(await b.api.getStatus()).toMatchObject({signingReady:false,sendBlocked:'firmware',address:''})
  expect(b.calls.transfers).toHaveLength(0); expect(b.calls.relays).toHaveLength(0)
})

test('prepare cryptographically selects both output orders and review order survives signing unchanged', async () => {
 const b = streamBridge()
 await b.api.connect(); await b.api.syncKeyImages()
 const recipient = b.p.outputs.find(o => !o.isChange)!
 const orders = new Set<string>()
 for (let run = 0; run < 128; run++) {
  const review = await b.api.prepareSend({address:recipient.address,amountAtomic:recipient.amountAtomic})
  orders.add(review.outputs.map(o => o.role).join(','))
 }
 expect([...orders].sort()).toEqual(['change,recipient', 'recipient,change'])
 const review = await prepareStream(b)
 await b.api.send({prepareId:review.prepareId})
 // Emulator asserts Init and each output/MAC request against the independent fixture;
 // Core preparation asserts the stored plan, and verification checks the assembled bytes.
 expect(review.outputs.map(o => o.address)).toEqual(b.p.outputs.map(o => o.address))
 expect(b.counts()).toEqual({verified:1,disposed:1})
})


test('payment keys survive pending retry, successful relay and restart in owner-only storage', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'kk-monero-payment-keys-'))
 const store = createFilePendingStore(dir), b = streamBridge(true, store)
 const review = await prepareStream(b)
 b.setRelayError(new Error('ETIMEDOUT'))
 await expect(b.api.send({prepareId:review.prepareId})).rejects.toThrow('broadcast result is unknown')
 const record = store.load()[0], expected = {txKey:hex(bytesField(parseFields(unhex(b.c.responses.at(-1)!.hex)),2)),additionalTxKeys:[]}
 expect(record.transactionKeys).toEqual(expected)
 expect(b.api.getTransactionKey(record.txid)).toEqual(expected)
 expect(statSync(join(dir,'monero-pending-broadcast.json')).mode & 0o777).toBe(0o600)
 b.setRelayError(null)
 await b.api.retryRelay()
 expect(b.api.pendingCount()).toBe(0)
 expect(store.loadSent!()[0].transactionKeys).toEqual(expected)
 expect(statSync(join(dir,'monero-sent-transactions.json')).mode & 0o777).toBe(0o600)
 const next = streamBridge(true,createFilePendingStore(dir))
 await next.api.connect()
 expect(next.api.getTransactionKey(record.txid)).toEqual(expected)
 expect(next.api.getTransactionKey('00'.repeat(32))).toBeNull()
 next.state.deviceId = 'another-device'
 await next.api.connect()
 expect(next.api.getTransactionKey(record.txid)).toBeNull()
})


test('Desktop Max reviews and signs a no-change plan without altering its zero output', async () => {
 for (const fixture of sweepFixtures.cases) {
  const dir = mkdtempSync(join(tmpdir(),'kk-monero-sweep-keys-')), store = createFilePendingStore(dir)
  const b = streamBridge(true, store, fixture)
  b.wallet.balanceAtomic = b.wallet.unlockedBalanceAtomic = b.p.inputs[0].amountAtomic
  await b.api.connect(); await b.api.syncKeyImages()
  const recipient = b.p.outputs.find(o=>o.amountAtomic!=='0')!
  const sweep = structuredClone(b.p) as MoneroPlan
  const probe = structuredClone(streamFixtures.cases[0].plan) as MoneroPlan
  b.setDraft(input => {
   const plan = input.amountAtomic===recipient.amountAtomic ? structuredClone(sweep) : structuredClone(probe)
   return {feeAtomic:plan.feeAtomic,amountAtomic:input.amountAtomic,plan}
  })
  let review
  for (let n=0;n<128;n++) {
   review = await b.api.prepareSend({address:recipient.address,max:true})
   if (review.outputs[0].address===sweep.outputs[0].address) break
  }
  expect(review!.amountAtomic).toBe(recipient.amountAtomic)
  expect(review!.changeAtomic).toBe('0')
  expect(review!.outputs.map(o=>o.amountAtomic)).toEqual(sweep.outputs.map(o=>o.amountAtomic))
  await b.api.send({prepareId:review!.prepareId})
  expect(b.calls.relays[0].txHex).toBe(fixture.transactionHex)
  const stored = createFilePendingStore(dir).loadSent!()[0]
  const expectedKeys = parseFields(unhex(fixture.responses.at(-1)!.hex))
  expect(stored.transactionKeys).toEqual({txKey:hex(bytesField(expectedKeys,2)),additionalTxKeys:(expectedKeys.get(3)??[]).map(k=>hex(k as Uint8Array))})
  expect(b.api.getTransactionKey(stored.txid)).toEqual(stored.transactionKeys ?? null)
 }
})

test('review permits only one paid recipient and one zero dummy without change', () => {
 const plan = structuredClone(sweepFixtures.cases[0].plan) as MoneroPlan
 const recipient = plan.outputs.find(o=>o.amountAtomic!=='0')!
 const owned = new Map(plan.inputs.map(i=>[i.ring[i.realMember].publicKey,{amountAtomic:i.amountAtomic,keyImage:'00'.repeat(32)}]))
 const requested = {address:recipient.address,amountAtomic:recipient.amountAtomic,walletAddress:WALLET,walletFeeAtomic:plan.feeAtomic,walletAmountAtomic:recipient.amountAtomic,owned}
 expect(reviewPlan(plan,requested).changeAtomic).toBe('0')
 const dummy = plan.outputs.find(o=>o.amountAtomic==='0')!
 dummy.amountAtomic='1'
 expect(()=>reviewPlan(plan,requested)).toThrow('recipient')
})

test('adapter unlock time reaches localized preflight without being silently dropped', () => {
 const raw = structuredClone(fixtures.cases.base.adapterPlan)
 expect(validatePlan({...raw,unlock_time:'3000000'}).unlockTime).toBe('3000000')
 expect(validatePlan({...raw,unlock_time:'0'}).unlockTime).toBe('0')
})


test('a payment-proof archive failure keeps the recoverable pending record', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'kk-monero-proof-save-'))
 const store = createFilePendingStore(dir)
 const b = streamBridge(true, {...store,saveSent(){throw Error('disk full')}})
 const review = await prepareStream(b)
 // The node accepted it, so the send succeeded (N4); the keys stay in the pending record.
 const { txid } = await b.api.send({prepareId:review.prepareId})
 expect(b.calls.relays).toHaveLength(1)
 expect(b.api.pendingCount()).toBe(1)
 expect(store.load()[0]).toMatchObject({ txid })
 expect(store.load()[0].transactionKeys).toBeDefined()
})

describe('N4: a tx is archived as sent only when it was sent, and an accepted broadcast is never reported as failed', () => {
 const SENT = 'monero-sent-transactions.json'
 const stored = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, store: createFilePendingStore(dir) }
 }
 const failingSave = (store: MoneroPendingStore): MoneroPendingStore => ({ ...store, saveSent: () => { throw new Error('disk full') } })
 /** A first broadcast whose outcome is unknown, so the tx is pending with its keys on disk. */
 const unknownSend = async (dir: string) => {
  const first = streamBridge(true, createFilePendingStore(dir))
  const review = await prepareStream(first)
  first.setRelayError(new Error('ETIMEDOUT'))
  await expect(first.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')
  return createFilePendingStore(dir).load()[0]
 }
 /** Warnings logged while `run` runs; they must never carry a txid or key material. */
 const warnings = async (run: () => Promise<unknown>) => {
  const logged: string[] = [], warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
  try { await run() } finally { warn.mockRestore() }
  return logged
 }
 const leaksNothing = (logged: string[], record: { txid: string; transactionKeys?: { txKey: string } }) => {
  for (const line of logged) {
   expect(line).not.toContain(record.txid)
   expect(line).not.toContain(record.transactionKeys!.txKey)
  }
 }

 describe('a tx that never landed is archived labelled, with its keys, never as sent', () => {
  test('a first broadcast the daemon rejected', async () => {
   const { dir, store } = stored('kk-monero-n4-reject-')
   const b = streamBridge(true, store)
   const review = await prepareStream(b)
   b.setRelayError(new Error('The daemon rejected the transaction: fee too low'))
   await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('fee too low')
   expect(b.api.pendingCount()).toBe(0)
   const [archived] = store.loadSent!()
   expect(archived.outcome).toBe('rejected')
   expect(archived.transactionKeys).toBeDefined()
   // A node that lied about the rejection cannot cost the payment-proof keys; the label comes with them.
   expect(b.api.getTransactionKey(archived.txid)).toEqual({ ...archived.transactionKeys!, outcome: 'rejected' })
   expect(JSON.parse(readFileSync(join(dir, SENT), 'utf8')).records[0].outcome).toBe('rejected')
  })

  test('a superseded tx (its inputs spent on chain by another tx), settled on connect', async () => {
   const { dir, store } = stored('kk-monero-n4-superseded-')
   const record = await unknownSend(dir)
   const next = streamBridge(true, store)
   next.setLookup({ state: 'unknown', keyImages: ['spent'] })
   expect((await next.api.connect()).unrelayedTxid).toBeUndefined()
   expect(next.api.pendingCount()).toBe(0)
   expect(store.loadSent!()).toEqual([{ ...record, outcome: 'superseded' }])
   expect(next.api.getTransactionKey(record.txid)).toEqual({ ...record.transactionKeys!, outcome: 'superseded' })
  })

  test('"double spend" that the node says another tx made', async () => {
   const { store } = stored('kk-monero-n4-double-spend-')
   const b = streamBridge(true, store)
   const review = await prepareStream(b)
   b.setRelayError(new Error('The daemon rejected the transaction: double spend'))
   b.setLookup({ state: 'unknown', keyImages: ['spent'] })
   await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('can never be sent')
   expect(b.api.pendingCount()).toBe(0)
   expect(store.loadSent!().map(record => record.outcome)).toEqual(['superseded'])
  })

  test('if archiving fails it still settles, with the daemon reason and a warning naming no tx', async () => {
   const { store } = stored('kk-monero-n4-reject-save-')
   // Capture the pending record written before the broadcast, to check the warnings against it.
   const written: Parameters<MoneroPendingStore['save']>[0] = []
   const b = streamBridge(true, { ...failingSave(store), save: records => { written.push(...records); store.save(records) } })
   const review = await prepareStream(b)
   b.setRelayError(new Error('The daemon rejected the transaction: fee too low'))
   const logged = await warnings(() => expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('fee too low'))
   expect(b.api.pendingCount()).toBe(0)
   expect(store.load()).toEqual([])
   expect(logged.some(line => line.includes('can never land without archiving its keys'))).toBe(true)
   const [record] = written
   leaksNothing(logged, record)
   expect(b.api.getTransactionKey(record.txid)).toBeNull()
  })

  test('a superseded tx whose archive fails does not block connecting or the wallet', async () => {
   const { dir, store } = stored('kk-monero-n4-superseded-save-')
   const record = await unknownSend(dir)
   const next = streamBridge(true, failingSave(store))
   next.setLookup({ state: 'unknown', keyImages: ['spent'] })
   const logged = await warnings(async () => { expect((await next.api.connect()).unrelayedTxid).toBeUndefined() })
   expect(next.api.pendingCount()).toBe(0)
   leaksNothing(logged, record)
  })
 })

 test('a sent tx is archived unlabelled; a discarded one too, since another node may still mine it', async () => {
  const { store } = stored('kk-monero-n4-sent-')
  const b = streamBridge(true, store)
  const review = await prepareStream(b)
  const { txid } = await b.api.send({ prepareId: review.prepareId })
  expect(store.loadSent!().map(record => [record.txid, record.outcome])).toEqual([[txid, undefined]])

  const other = stored('kk-monero-n4-discard-')
  const record = await unknownSend(other.dir)
  const next = streamBridge(true, other.store)
  await next.api.connect()
  next.setLookup({ state: 'unknown', keyImages: ['unspent'] })
  expect(await next.api.discardPending({ confirm: true })).toEqual({ outcome: 'discarded', txid: record.txid })
  expect(other.store.loadSent!()).toEqual([record])
 })

 test('archived labels are validated: an unknown label is kept aside, older unlabelled records still load', async () => {
  const { dir, store } = stored('kk-monero-n4-labels-')
  const record = await unknownSend(dir)
  writeFileSync(join(dir, SENT), JSON.stringify({ version: 1, records: [record] }), { mode: 0o600 })
  expect(store.loadSent!()).toEqual([record])
  writeFileSync(join(dir, SENT), JSON.stringify({ version: 1, records: [{ ...record, outcome: 'rejected' }] }), { mode: 0o600 })
  expect(store.loadSent!()).toEqual([{ ...record, outcome: 'rejected' }])
  writeFileSync(join(dir, SENT), JSON.stringify({ version: 1, records: [{ ...record, outcome: 'sent' }] }), { mode: 0o600 })
  const logged = await warnings(async () => { expect(store.loadSent!()).toEqual([]) })
  expect(readdirSync(dir).some(name => name.startsWith('monero-sent-transactions.unreadable-'))).toBe(true)
  expect(JSON.parse(readFileSync(join(dir, SENT), 'utf8'))).toEqual({ version: 1, records: [] })
  leaksNothing(logged, record)
 })

 describe('the node has the tx but its proof cannot be archived: the send succeeded', () => {
  test('first broadcast accepted: the txid is returned, the keys stay pending, the warning names no tx', async () => {
   const { store } = stored('kk-monero-n4-accept-save-')
   const b = streamBridge(true, failingSave(store))
   const review = await prepareStream(b)
   let txid = ''
   const logged = await warnings(async () => { ({ txid } = await b.api.send({ prepareId: review.prepareId })) })
   expect(b.calls.relays).toHaveLength(1)
   expect(b.api.pendingCount()).toBe(1)
   const [record] = store.load()
   expect(record.txid).toBe(txid)
   expect(b.api.getTransactionKey(txid)).toEqual(record.transactionKeys!)
   expect(logged.some(line => line.includes('stays pending because its payment proof could not be archived'))).toBe(true)
   leaksNothing(logged, record)
  })

  test('"double spend" made by this tx: the txid is returned', async () => {
   const { store } = stored('kk-monero-n4-lookup-save-')
   const b = streamBridge(true, failingSave(store))
   const review = await prepareStream(b)
   b.setRelayError(new Error('The daemon rejected the transaction: double spend'))
   b.setLookup({ state: 'mined', height: 90, keyImages: ['spent'] })
   const { txid } = await b.api.send({ prepareId: review.prepareId })
   expect(store.load()[0]).toMatchObject({ txid })
   expect(store.load()[0].transactionKeys).toBeDefined()
  })

  test('Retry broadcast returns the txid without relaying again', async () => {
   const { dir, store } = stored('kk-monero-n4-retry-save-')
   const record = await unknownSend(dir)
   const next = streamBridge(true, failingSave(store))
   await next.api.connect()
   next.setLookup({ state: 'pool', keyImages: ['pool'] })
   expect(await next.api.retryRelay()).toEqual({ txid: record.txid })
   expect(next.calls.relays).toHaveLength(0)
   expect(next.api.pendingCount()).toBe(1)
  })

  test('Discard reports it as sent, writes no guard and keeps it pending', async () => {
   const { dir, store } = stored('kk-monero-n4-discard-sent-')
   const record = await unknownSend(dir)
   const next = streamBridge(true, failingSave(store))
   await next.api.connect()
   next.setLookup({ state: 'pool', keyImages: ['pool'] })
   expect(await next.api.discardPending({ confirm: true })).toEqual({ outcome: 'sent', txid: record.txid })
   expect(next.api.pendingCount()).toBe(1)
   expect(existsSync(join(dir, 'monero-discarded-broadcast.json'))).toBe(false)
   expect(store.load()[0].transactionKeys).toEqual(record.transactionKeys)
  })

  test('the tx left pending is archived and cleared on the next connect once saving works', async () => {
   const { dir, store } = stored('kk-monero-n4-recover-')
   const b = streamBridge(true, failingSave(store))
   const review = await prepareStream(b)
   const { txid } = await b.api.send({ prepareId: review.prepareId })
   expect(b.api.pendingCount()).toBe(1)

   const next = streamBridge(true, createFilePendingStore(dir))
   next.setLookup({ state: 'pool', keyImages: ['pool'] })
   expect((await next.api.connect()).unrelayedTxid).toBeUndefined()
   expect(next.api.pendingCount()).toBe(0)
   expect(createFilePendingStore(dir).loadSent!().map(record => [record.txid, record.outcome])).toEqual([[txid, undefined]])
  })
 })

 describe('KEEPKEY-143: the status says when a sent tx stays pending only because its proof could not be saved', () => {
  /** A store whose proof saves fail until `fixed` is set, like a full disk that is then cleared. */
  const flakyDisk = (store: MoneroPendingStore) => {
   const disk = { fixed: false }
   const wrapped: MoneroPendingStore = { ...store, saveSent: records => { if (!disk.fixed) throw new Error('disk full'); store.saveSent!(records) } }
   return { disk, store: wrapped }
  }

  test('an accepted send whose proof fails is flagged; freeing the disk and checking again clears it and archives the keys', async () => {
   const { store } = stored('kk-monero-143-accept-')
   const flaky = flakyDisk(store), b = streamBridge(true, flaky.store)
   const review = await prepareStream(b)
   const { txid } = await b.api.send({ prepareId: review.prepareId })
   let status = await b.api.getStatus()
   expect(status).toMatchObject({ unrelayedTxid: txid, unrelayedProofNotSaved: true, sendBlocked: 'unrelayed' })
   expect(status.unrelayedCheck).toBeUndefined()
   // Still failing: Check again keeps the flag.
   b.setLookup({ state: 'pool', keyImages: ['pool'] })
   expect(await b.api.retryRelay()).toEqual({ txid })
   expect((await b.api.getStatus()).unrelayedProofNotSaved).toBe(true)
   // Disk fixed: Check again archives the keys and the notice goes away.
   flaky.disk.fixed = true
   expect(await b.api.retryRelay()).toEqual({ txid })
   status = await b.api.getStatus()
   expect(status.unrelayedTxid).toBeUndefined()
   expect(status.unrelayedProofNotSaved).toBeUndefined()
   expect(store.loadSent!().map(record => record.txid)).toEqual([txid])
  })

  test('after a restart, connect raises the flag again while saving still fails', async () => {
   const { dir, store } = stored('kk-monero-143-restart-')
   const record = await unknownSend(dir)
   const next = streamBridge(true, failingSave(store))
   next.setLookup({ state: 'pool', keyImages: ['pool'] })
   expect(await next.api.connect()).toMatchObject({ unrelayedTxid: record.txid, unrelayedProofNotSaved: true })
  })

  test('an unreadable proof store raises it too', async () => {
   const { dir, store } = stored('kk-monero-143-unreadable-')
   const record = await unknownSend(dir)
   const next = streamBridge(true, { ...store, loadSent: () => { throw new Error('The Monero payment-proof records could not be read') } })
   next.setLookup({ state: 'pool', keyImages: ['pool'] })
   expect(await next.api.connect()).toMatchObject({ unrelayedTxid: record.txid, unrelayedProofNotSaved: true })
  })

  test('a proof file written by a newer app version (after a downgrade) raises it, since it can never be saved over', async () => {
   const { dir, store } = stored('kk-monero-143-newer-')
   const record = await unknownSend(dir)
   writeFileSync(join(dir, 'monero-sent-transactions.json'), JSON.stringify({ version: 2, records: [] }), { mode: 0o600 })
   const next = streamBridge(true, store)
   next.setLookup({ state: 'pool', keyImages: ['pool'] })
   expect(await next.api.connect()).toMatchObject({ unrelayedTxid: record.txid, unrelayedProofNotSaved: true })
   expect(JSON.parse(readFileSync(join(dir, 'monero-sent-transactions.json'), 'utf8'))).toEqual({ version: 2, records: [] })
  })

  test('Discard of a flagged tx reports it as sent and keeps the notice', async () => {
   const { dir, store } = stored('kk-monero-143-discard-')
   const record = await unknownSend(dir)
   const next = streamBridge(true, failingSave(store))
   next.setLookup({ state: 'pool', keyImages: ['pool'] })
   await next.api.connect()
   expect(await next.api.discardPending({ confirm: true })).toEqual({ outcome: 'sent', txid: record.txid })
   expect(await next.api.getStatus()).toMatchObject({ unrelayedTxid: record.txid, unrelayedProofNotSaved: true })
  })

  test('a plain unknown outcome is never flagged', async () => {
   const { dir, store } = stored('kk-monero-143-unknown-')
   const record = await unknownSend(dir)
   const next = streamBridge(true, store)
   const status = await next.api.connect()
   expect(status.unrelayedTxid).toBe(record.txid)
   expect(status.unrelayedProofNotSaved).toBeUndefined()
   expect(status.unrelayedCheck).toMatchObject({ state: 'unknown' })
  })

  test('if the node later no longer has the tx, the flag goes; a failed lookup keeps the last answer', async () => {
   const { dir, store } = stored('kk-monero-143-dropped-')
   const record = await unknownSend(dir)
   const next = streamBridge(true, failingSave(store))
   next.setLookup({ state: 'pool', keyImages: ['pool'] })
   await next.api.connect()
   // The node cannot be reached at all (lookup and relay fail): the last answer (it was sent) still stands.
   next.setLookup(new Error('The Monero daemon is unavailable'))
   next.setRelayError(new Error('ETIMEDOUT'))
   await expect(next.api.retryRelay()).rejects.toThrow('broadcast result is unknown')
   expect((await next.api.getStatus()).unrelayedProofNotSaved).toBe(true)
   // The node now answers that it does not have it: it is no longer known to be sent.
   next.setLookup({ state: 'unknown', keyImages: ['unspent'] })
   await expect(next.api.retryRelay()).rejects.toThrow('broadcast result is unknown')
   const status = await next.api.getStatus()
   expect(status.unrelayedTxid).toBe(record.txid)
   expect(status.unrelayedProofNotSaved).toBeUndefined()
   expect(status.unrelayedCheck).toMatchObject({ state: 'unknown' })
  })
 })
})

describe('N2: unreadable payment-proof records never block the other guards or get overwritten', () => {
 const SENT = 'monero-sent-transactions.json'
 const CORRUPT = '{"version":1,"records":[{broken'
 const withProofFile = (prefix: string, content: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, SENT), content, { mode: 0o600 })
  return dir
 }
 const keptAside = (dir: string) => readdirSync(dir).filter(name => name.startsWith('monero-sent-transactions.unreadable-'))
 /** A proof store that cannot even be read (I/O error): the vault must not write over it. */
 const unreadable = (dir: string) => {
  const saves: unknown[] = []
  const store: MoneroPendingStore = { ...createFilePendingStore(dir),
   loadSent: () => { throw new Error('The Monero payment-proof records could not be read') },
   saveSent: records => { saves.push(records) } }
  return { store, saves }
 }

 describe('file store: a corrupt file is kept aside, never overwritten', () => {
  test('status, pending count and the double-payment block load; the original bytes are preserved', async () => {
   const dir = mkdtempSync(join(tmpdir(), 'kk-monero-n2-status-'))
   const first = await ready({ pendingStore: createFilePendingStore(dir) })
   first.setRelayError(new Error('The Monero daemon is unavailable'))
   const review = await first.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
   await expect(first.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')
   writeFileSync(join(dir, SENT), CORRUPT, { mode: 0o600 })

   const restarted = bridge({ pendingStore: createFilePendingStore(dir) })
   restarted.setDraft(walletDraft)
   expect((await restarted.api.getStatus()).unrelayedTxid).toBe(referenceHash('base'))
   expect(restarted.api.pendingCount()).toBe(1)
   await restarted.api.connect(); await restarted.api.syncKeyImages()
   await expect(restarted.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })).rejects.toThrow('retry broadcasting')
   const aside = keptAside(dir)
   expect(aside).toHaveLength(1)
   expect(readFileSync(join(dir, aside[0]), 'utf8')).toBe(CORRUPT)
   // Owner-only mode is a POSIX check; Windows reports 0o666 for any writable file.
   if (process.platform !== 'win32') expect(statSync(join(dir, aside[0])).mode & 0o777).toBe(0o600)
   expect(JSON.parse(readFileSync(join(dir, SENT), 'utf8'))).toEqual({ version: 1, records: [] })
  })

  test('a key that is not found, while damaged records sit aside, is reported as possibly among them', async () => {
   const dir = withProofFile('kk-monero-n2-aside-', CORRUPT)
   const b = streamBridge(true, createFilePendingStore(dir))
   await b.api.connect()
   expect(() => b.api.getTransactionKey('00'.repeat(32))).toThrow('damaged and kept aside')
  })

  test('a send then archives its keys normally, and the old file stays aside', async () => {
   const dir = withProofFile('kk-monero-n2-send-', CORRUPT)
   const b = streamBridge(true, createFilePendingStore(dir))
   const review = await prepareStream(b)
   await b.api.send({ prepareId: review.prepareId })
   expect(b.api.pendingCount()).toBe(0)
   const archived = createFilePendingStore(dir).loadSent!()
   expect(archived).toHaveLength(1)
   expect(b.api.getTransactionKey(archived[0].txid)).toEqual(archived[0].transactionKeys!)
   expect(readFileSync(join(dir, keptAside(dir)[0]), 'utf8')).toBe(CORRUPT)
  })

  test('records that fail validation or a missing records list are kept aside instead of being dropped on the next save', () => {
   for (const content of [JSON.stringify({ version: 1, records: [{ wallet: 'x' }] }), JSON.stringify({ version: 1 })]) {
    const dir = withProofFile('kk-monero-n2-shape-', content)
    expect(createFilePendingStore(dir).loadSent!()).toEqual([])
    expect(readFileSync(join(dir, keptAside(dir)[0]), 'utf8')).toBe(content)
   }
   // A file from a newer app version is not damaged: it is refused, never rewritten (e.g. after a downgrade).
   const newer = JSON.stringify({ version: 2, entries: [] })
   const newerDir = withProofFile('kk-monero-n2-newer-', newer)
   expect(() => createFilePendingStore(newerDir).loadSent!()).toThrow('could not be read')
   expect(readFileSync(join(newerDir, SENT), 'utf8')).toBe(newer)
   expect(keptAside(newerDir)).toEqual([])
   const dir = withProofFile('kk-monero-n2-valid-', JSON.stringify({ version: 1, records: [] }))
   createFilePendingStore(dir).loadSent!()
   expect(keptAside(dir)).toEqual([])
  })
 })

 describe('a store that cannot be read: nothing is written over it', () => {
  test('the discard guard still loads and applies', async () => {
   const dir = mkdtempSync(join(tmpdir(), 'kk-monero-n2-guard-'))
   const first = streamBridge(true, createFilePendingStore(dir))
   const review = await prepareStream(first)
   first.setRelayError(new Error('ETIMEDOUT'))
   await expect(first.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')
   first.setLookup({ state: 'unknown', keyImages: ['unspent'] })
   const { txid } = await first.api.discardPending({ confirm: true })

   const next = streamBridge(true, unreadable(dir).store)
   expect((await next.api.connect()).discardedTxid).toBe(txid)
  })

  test('a sent tx stays pending with its keys; other keys report the read error instead of "none"', async () => {
   const dir = mkdtempSync(join(tmpdir(), 'kk-monero-n2-io-'))
   const { store, saves } = unreadable(dir)
   const b = streamBridge(true, store)
   const review = await prepareStream(b)
   // Broadcast succeeded, so the send reports its txid (N4) while the tx keeps its keys pending.
   const { txid } = await b.api.send({ prepareId: review.prepareId })
   expect(b.calls.relays).toHaveLength(1)
   expect(saves).toEqual([])
   expect(b.api.pendingCount()).toBe(1)
   const record = createFilePendingStore(dir).load()[0]
   expect(record.txid).toBe(txid)
   expect(b.api.getTransactionKey(record.txid)).toEqual(record.transactionKeys!)
   expect(() => b.api.getTransactionKey('00'.repeat(32))).toThrow('payment-proof records could not be read')
  })

  test('a rejected first broadcast still shows the daemon reason and clears the never-sent tx', async () => {
   const dir = mkdtempSync(join(tmpdir(), 'kk-monero-n2-reject-'))
   const { store, saves } = unreadable(dir)
   const b = streamBridge(true, store)
   const review = await prepareStream(b)
   b.setRelayError(new Error('The daemon rejected the transaction: fee too low'))
   await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('fee too low')
   expect(b.api.pendingCount()).toBe(0)
   expect(saves).toEqual([])
  })

  test('a discard whose proof save fails removes the guard it just wrote', async () => {
   const dir = mkdtempSync(join(tmpdir(), 'kk-monero-n2-discard-save-'))
   const first = streamBridge(true, createFilePendingStore(dir))
   const review = await prepareStream(first)
   first.setRelayError(new Error('ETIMEDOUT'))
   await expect(first.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')

   const next = streamBridge(true, { ...createFilePendingStore(dir), saveSent: () => { throw new Error('disk full') } })
   await next.api.connect()
   next.setLookup({ state: 'unknown', keyImages: ['unspent'] })
   await expect(next.api.discardPending({ confirm: true })).rejects.toThrow('transaction remains pending')
   expect(next.api.pendingCount()).toBe(1)
   expect((await next.api.getStatus()).discardedTxid).toBeUndefined()
   expect(existsSync(join(dir, 'monero-discarded-broadcast.json'))).toBe(false)
  })

  test('a discard keeps the tx pending with its keys and writes no guard', async () => {
   const dir = mkdtempSync(join(tmpdir(), 'kk-monero-n2-discard-'))
   const first = streamBridge(true, createFilePendingStore(dir))
   const review = await prepareStream(first)
   first.setRelayError(new Error('ETIMEDOUT'))
   await expect(first.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')

   const { store, saves } = unreadable(dir)
   const next = streamBridge(true, store)
   await next.api.connect()
   next.setLookup({ state: 'unknown', keyImages: ['unspent'] })
   await expect(next.api.discardPending({ confirm: true })).rejects.toThrow('transaction remains pending')
   expect(next.api.pendingCount()).toBe(1)
   expect(existsSync(join(dir, 'monero-discarded-broadcast.json'))).toBe(false)
   expect(saves).toEqual([])
  })

  test('a superseded tx (its inputs were spent by another tx, so it can never land) settles instead of blocking the wallet', async () => {
   const dir = mkdtempSync(join(tmpdir(), 'kk-monero-n2-superseded-'))
   const first = streamBridge(true, createFilePendingStore(dir))
   const review = await prepareStream(first)
   first.setRelayError(new Error('ETIMEDOUT'))
   await expect(first.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')

   const { store, saves } = unreadable(dir)
   const next = streamBridge(true, store)
   next.setLookup({ state: 'unknown', keyImages: ['spent'] })
   await next.api.connect()
   expect(next.api.pendingCount()).toBe(0)
   expect(saves).toEqual([])
  })

  test('connecting works when the node has the pending tx but its proof cannot be archived', async () => {
   const dir = mkdtempSync(join(tmpdir(), 'kk-monero-n2-connect-'))
   const first = streamBridge(true, createFilePendingStore(dir))
   const review = await prepareStream(first)
   first.setRelayError(new Error('ETIMEDOUT'))
   await expect(first.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')

   const { store, saves } = unreadable(dir)
   const next = streamBridge(true, store)
   next.setLookup({ state: 'pool', keyImages: ['pool'] })
   expect((await next.api.connect()).sendBlocked).toBe('unrelayed')
   expect(next.api.pendingCount()).toBe(1)
   expect(saves).toEqual([])
  })
 })
})

// Native qualification uses public vectors and fixture reports; never a USB device or daemon.
test.skipIf(!process.env.MONERO_CORE_VERIFY_DIR)('Desktop completes standard and subaddress hardware flows through the actual pinned Core verifier', async () => {
 const native = createMoneroCoreVerifier({directory:process.env.MONERO_CORE_VERIFY_DIR})
 expect(native.available()).toBe(true)
 for (const fixture of streamFixtures.cases) {
  const b = streamBridge(true, undefined, fixture, native)
  const review = await prepareStream(b)
  await b.api.send({prepareId:review.prepareId})
  expect(b.counts()).toEqual({verified:1,disposed:1})
  expect(b.calls.relays).toHaveLength(1)
  expect(b.calls.relays[0].txHex).toBe(fixture.transactionHex)
 }
})


test('removing the native verifier after review stops before Init and leaves no pending payment', async () => {
 const b = streamBridge(), review = await prepareStream(b), before = sentTypes(b).length
 b.coreVerifier.available = () => false
 await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('Core verifier is unavailable')
 expect(sentTypes(b)).toHaveLength(before)
 expect(b.calls.relays).toHaveLength(0)
 expect(b.api.pendingCount()).toBe(0)
 expect(b.counts()).toEqual({ verified: 0, disposed: 0 })
})

test('a wrong monitoring credential on reconnect cannot reuse the retired subaddress signing key', async () => {
 const b = streamBridge(true, undefined, streamFixtures.cases[1])
 await prepareStream(b)
 b.api.invalidate()
 b.delegate.watchViewKey = new Uint8Array(32).fill(1)
 await b.api.connect(); await b.api.syncKeyImages()
 const recipient = b.p.outputs.find(o => !o.isChange)!, before = sentTypes(b).length
 await expect(b.api.prepareSend({ address: recipient.address, amountAtomic: recipient.amountAtomic })).rejects.toThrow('authorize subaddress change derivation')
 expect(sentTypes(b)).toHaveLength(before)
 expect(b.calls.relays).toHaveLength(0)
 expect(b.api.pendingCount()).toBe(0)
})


test('turning Monero offline during streamed subaddress signing stops before signatures and disposes verification', async () => {
 const b = streamBridge(true, undefined, streamFixtures.cases[1]), review = await prepareStream(b)
 b.delegate.streamHook = async type => { if (type === 1818) b.config.offline = true }
 await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('changed')
 expect(sentTypes(b)).not.toContain(1822)
 expect(sentTypes(b)).not.toContain(1824)
 expect(b.calls.relays).toHaveLength(0)
 expect(b.api.pendingCount()).toBe(0)
 expect(b.counts()).toEqual({ verified: 0, disposed: 1 })
 expect((await b.api.getStatus()).address).toBe('')
})
