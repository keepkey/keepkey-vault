import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { checkRelayResponse, parseExactJson, validateKeyImageImport, validateOutputs, validatePlan, validateRelayRequest,
  validateTransferRequest, type MoneroPlan } from '../../monero-cli/src/protocol'
import { relayRawTransaction } from '../../monero-cli/src/wallet'
import { DigestWalletRpc } from '../../monero-cli/src/digest'
import { checkSignedTransaction, concat, keyImageInitRequest, lengthField, openKeyImage, parseFields, parseSignedTransaction, reviewPlan,
  signRequest, transferDetails, varint } from './monero-wire'
import { createMoneroVault, type MoneroWatchSidecar } from './monero-vault'
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
    expect(variant(v => { v.outputs[0].amount = '0' })).toThrow()
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
    expect(() => checkRelayResponse({ ...ok, status: 'BUSY' })).toThrow('rejected')
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
    await expect(relayRawTransaction('http://127.0.0.1:18081', undefined, 'abcd', async () => new Response('x'.repeat(70000)))).rejects.toThrow('rejected')
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
  onButtonRequest: (() => void) | null = null
  queue: Uint8Array[] = []
  pending: Array<[number, Uint8Array]> = []
  received: Array<{ type: number; body: Uint8Array }> = []
  partial: { type: number; length: number; data: number[] } | null = null
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
    this.queue.push(...reports(first[0], first[1]))
    if (first[0] === 26) this.pending = rest
  }
  private handle(type: number, body: Uint8Array) {
    this.received.push({ type, body })
    const images = fixtures.cases.base.signedTransaction.keyImages as string[]
    if (type === 27) { if (this.pending[0]?.[0] === 26 || this.pending[0]?.[0] === 65001) this.onReviewScreen?.(); return this.respond(this.pending) }
    if (type === 20) return this.respond([[3, new Uint8Array([8, 4])]])
    if (this.pinLocked && (type === 540 || type === 542 || type === 530 || type === 65000)) return this.respond([[18, new Uint8Array([8, 1])]])
    if (type === 540) {
      const minor = Number(parseFields(body).get(5)?.[0] ?? 0n)
      return this.respond([[541, lengthField(1, new TextEncoder().encode(minor ? SUBADDRESS : this.address))]])
    }
    if (type === 542) return this.respond([[26, new Uint8Array()], [543, concat([lengthField(1, new Uint8Array(32).fill(7)), lengthField(2, new TextEncoder().encode(this.address))])]])
    if (type === 530) return this.respond([[26, new Uint8Array()], [531, new Uint8Array()]])
    if (type === 532) {
      // Key image per output: the fixture's for the fixture output, a derived one for synthetic outputs.
      const outKeys = parseFields(body).get(1)!.map(record => hex(parseFields(record as Uint8Array).get(1)![0] as Uint8Array))
      return this.respond([[533, concat(outKeys.map((outKey, i) => {
        const image = outKey === fixtures.cases.base.adapterOutputs.outputs[0].out_key ? images[0] : hex(keccak_256(unhex(outKey)))
        const iv = new Uint8Array(12).fill(i + 1), plain = concat([unhex(image), new Uint8Array(64).fill(5)])
        return lengthField(1, concat([lengthField(1, iv), lengthField(3, chacha20poly1305(ENC_KEY, iv).encrypt(plain))]))
      }))]])
    }
    if (type === 534) return this.respond([[535, lengthField(1, ENC_KEY.slice())]])
    if (type === 65000) {
      const screens: Array<[number, Uint8Array]> = Array.from({ length: this.reviewScreens }, () => [26, new Uint8Array()])
      // Each ButtonRequest waits for its own ButtonAck before the next message.
      return this.respond([...screens, [65001, concat([lengthField(1, this.signedBlob), lengthField(2, this.signedHash)])]])
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

function bridge(options: { signing?: boolean; sendReady?: boolean; monitorReady?: boolean; pendingStore?: MoneroPendingStore } = {}) {
  const delegate = new Emulator()
  const calls: Record<string, any[]> = { imports: [], transfers: [], relays: [], refreshes: [] }
  // The watch wallet as the sidecar reports it; tests edit it (new tx, node down, scanning).
  const wallet: Record<string, any> = { balanceAtomic: '7000000000000', unlockedBalanceAtomic: '7000000000000', walletHeight: 120, transactions: [],
    monitorReady: options.monitorReady !== false }
  const watch = () => ({ network: 'mainnet', address: delegate.address, canSend: false, updatedAt: new Date().toISOString(), ...structuredClone(wallet) })
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
    async importMoneroKeyImages(input) { calls.imports.push(input); return { height: 120, spentAtomic: '0', unspentAtomic: '7000000000000' } },
    async createMoneroTransfer(input) { calls.transfers.push(input); if (transferError) throw transferError; return draft(input) },
    async relayMoneroTransaction(input) { calls.relays.push(input); if (relayError) throw relayError; return { relayed: true } },
    async refreshMoneroWatch() { calls.refreshes.push(true) },
  }
  const transport = { delegate, lockDuring: <T,>(operation: () => Promise<T>) => operation() }
  const state: { state: string; deviceId: string; activeTransport: string; isHiddenWallet: boolean; firmwareVersion: string } = { state: 'ready', deviceId: 'PUBLIC-EMULATOR', activeTransport: 'emulator', isHiddenWallet: false, firmwareVersion: '7.17.0' }
  const config: { enabled: boolean; offline: boolean; daemonUrl: string; restoreHeight: number | null } = { enabled: true, offline: false, daemonUrl: 'http://127.0.0.1:18081', restoreHeight: 0 }
  const engine = { isEmulator: true, wallet: { transport }, emuDelegate: delegate, currentSeedEthAddress: null as string | null, getDeviceState: () => ({ ...state }) }
  const confirmed: any[] = []
  const confirm = async (operation: () => Promise<any>, details: any) => {
    confirmed.push(details); delegate.onButtonRequest = () => {}
    try { return await operation() } finally { delegate.onButtonRequest = null }
  }
  const api = createMoneroVault({ engine, confirm, sidecar, signingEmulator: () => options.signing !== false,
    getConfig: () => ({ ...config }), pendingStore: options.pendingStore })
  return { api, delegate, calls, confirmed, engine, state, config, wallet,
    setDraft(next: typeof draft) { draft = next }, setRelayError(error: Error | null) { relayError = error },
    setTransferError(error: Error | null) { transferError = error }, setOutputs(next: typeof outputs) { outputs = next } }
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
    expect(hex(request.body)).toBe(fixtures.cases.base.signRequestHex)
    expect(sentTypes(b).slice(-4)).toEqual([65000, 27, 27, 27])
    expect(b.confirmed.at(-1)).toEqual({ operation: 'moneroSend', chain: 'Monero', to: RECIPIENT, value: '2.000000000000 XMR', fee: '0.000020000000 XMR' })
    expect(b.calls.relays).toEqual([{ txHex: fixtures.cases.base.signedTransaction.hex }])
    // Spent inputs changed: the next send needs a new key-image sync, and the review is single use.
    expect((await b.api.getStatus()).sendBlocked).toBe('key-images')
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('expired')
  })

  test('each gate explains itself and nothing reaches the device or wallet before it is met', async () => {
    const receiveOnly = bridge({ signing: false })
    await receiveOnly.api.connect()
    expect((await receiveOnly.api.getStatus()).sendBlocked).toBe('emulator')
    const noAdapter = bridge({ sendReady: false })
    await noAdapter.api.connect()
    expect((await noAdapter.api.getStatus()).sendBlocked).toBe('adapter')
    await expect(noAdapter.api.prepareSend({ address: RECIPIENT, amountAtomic: '1' })).rejects.toThrow('adapter')
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
    b.setRelayError(new Error('The daemon rejected the transaction: double spend'))
    review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('double spend')
    expect(b.calls.relays).toHaveLength(1)
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

  test('exactly the balance minus the fee (zero change) is explained, never signed; balance minus less than the fee is short', async () => {
    const b = await ready()
    await expect(b.api.prepareSend({ address: RECIPIENT, amountAtomic: (UNLOCKED - FEE).toString() })).rejects.toThrow('leaves no change output')
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
    expect((await b.api.prepareSend({ address: SUBADDRESS, amountAtomic: '2000000000000' })).outputs[0]).toEqual({ role: 'recipient', address: SUBADDRESS, amountAtomic: '2000000000000' })
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

  test('the block belongs to the wallet that signed: a passphrase wallet is not blocked, its owner still is', async () => {
    const { store: pendingStore } = store()
    const b = await ready({ pendingStore })
    b.setRelayError(new Error('ETIMEDOUT'))
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('broadcast result is unknown')
    b.state.isHiddenWallet = true; b.engine.currentSeedEthAddress = '0xpassphrase'; b.delegate.address = RECIPIENT
    const hidden = await b.api.connect()
    expect(hidden.address).toBe(RECIPIENT)
    expect(hidden.sendBlocked).not.toBe('unrelayed')
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

  test('if the record cannot be saved, the signed transaction is not broadcast', async () => {
    const b = await ready({ pendingStore: { load: () => [], save: () => { throw new Error('disk full') } } })
    const review = await b.api.prepareSend({ address: RECIPIENT, amountAtomic: '2000000000000' })
    await expect(b.api.send({ prepareId: review.prepareId })).rejects.toThrow('could not be saved for recovery, so it was not broadcast')
    expect(b.calls.relays).toHaveLength(0)
    expect((await b.api.getStatus()).unrelayedTxid).toBeUndefined()
  })
})

describe('C4: the scan start', () => {
  test('connecting with no scan start chosen is refused before the device is asked', async () => {
    const b = bridge()
    b.config.restoreHeight = null
    expect((await b.api.getStatus()).restoreHeight).toBeUndefined()
    await expect(b.api.connect()).rejects.toThrow('Choose the block where the wallet scan starts')
    expect(b.delegate.received).toHaveLength(0)
  })
})
