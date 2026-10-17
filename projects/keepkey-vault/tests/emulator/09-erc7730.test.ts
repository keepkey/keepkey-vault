/**
 * Test 9: ERC-7730 replay through hdwallet on a stock 7.16.0 emulator.
 *
 * Every fixture is signed twice on a blank in-memory flash:
 *   calldata: AdvancedMode on, no definition (blind)  vs  AdvancedMode off + definition
 *   EIP-712:  no definition (streaming review)         vs  the same + definition
 * The definition may add screens but must never change what is signed, so the
 * two signatures must be identical (python-keepkey's additive rule).
 *
 * Runs in thread mode with a reactive DebugLinkDecision, like
 * 07-reactive-confirm. Each ButtonRequest also reads the screen's title and
 * body over DebugLink (DebugLinkState.confirm_title / confirm_body), and every
 * EthereumClearSignDefinitionRequest (1711) is counted and decoded.
 *
 * Needs the test-signed fixture and a firmware that trusts its test root, so
 * it is skipped unless KK_ERC7730_FIXTURE is set. Run it with
 * `make test-emu-erc7730`: KK_CLEARSIGN_TEST_ROOT is read by C getenv() in
 * kkemu_init, so it must be exported before bun starts.
 *
 * Optional: KK_ERC7730_LIMIT=n (first n of each kind), KK_ERC7730_FILTER=text
 * (fixture id substring), KK_ERC7730_SHARD=i/n (every n-th case from i, so n
 * processes can share the run), KK_ERC7730_REPORT=path (JSON results).
 */
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { describe, test, expect, afterAll } from 'bun:test'
import { createHash } from 'crypto'
import * as core from '@keepkey/hdwallet-core'
import { Transport, type TransportDelegate } from '@keepkey/hdwallet-keepkey'
import { utils } from 'ethers'
import { DYLIB_PATH, TEST_MNEMONIC } from './harness'

const FIXTURE = process.env.KK_ERC7730_FIXTURE
const REPORT = process.env.KK_ERC7730_REPORT
const LIMIT = Number(process.env.KK_ERC7730_LIMIT || 0)
const FILTER = process.env.KK_ERC7730_FILTER || ''
const [SHARD, SHARDS] = (process.env.KK_ERC7730_SHARD || '0/1').split('/').map(Number)
const SIGN_TIMEOUT_MS = 120_000
const PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]

const MSG_FAILURE = 3
const MSG_BUTTON_REQUEST = 26
const MSG_DEBUG_GET_STATE = 101
const MSG_DEBUG_STATE = 102
const MSG_DEFINITION_REQUEST = 1711

// ── Fixture ────────────────────────────────────────────────────────────

type FxDefinition = {
  definitionId: string; envelope: string; kind: number | string; chainId: number | string
  contractAddress?: string; selectorOrTypeHash?: string
}
type FxCalldata = {
  id: string; description: string; definitionId: string; innerDefinitionIds: string[]
  lookup: { chainId: number; contract: string; selector: string }
  tx: { chainId: number; nonce: string; maxFeePerGas: string; maxPriorityFeePerGas: string; gasLimit: string; to: string; value: string; data: string }
}
type FxEip712 = {
  id: string; description: string; definitionId: string
  lookup: { chainId: number; contract: string; typeHash: string }
  typedData: { types: Record<string, any>; domain: any; primaryType: string; message: any }
}
type Fixture = { testRootPubkey: string; firmware: string; definitions: FxDefinition[]; calldata: FxCalldata[]; eip712: FxEip712[] }

const fixture: Fixture | null = FIXTURE ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null
const pick = <T extends { id: string }>(list: T[]) => {
  const hits = list.filter((x, i) => x.id.includes(FILTER) && i % SHARDS === SHARD)
  return LIMIT > 0 ? hits.slice(0, LIMIT) : hits
}
const calldataCases = fixture ? pick(fixture.calldata) : []
const eip712Cases = fixture ? pick(fixture.eip712) : []
const definitionsById = new Map((fixture?.definitions ?? []).map((d) => [d.definitionId, d]))

function toDefinition(d: FxDefinition): core.ETHErc7730Definition {
  return {
    definitionId: d.definitionId,
    envelope: d.envelope,
    kind: Number(d.kind) as 1 | 2,
    chainId: Number(d.chainId),
    contractAddress: d.contractAddress,
    selectorOrTypeHash: d.selectorOrTypeHash,
  }
}

function definition(id: string): core.ETHErc7730Definition {
  const d = definitionsById.get(id)
  if (!d) throw new Error(`fixture has no definition ${id}`)
  return toDefinition(d)
}

// Answers the device's inner-call lookup from the whole fixture catalog, as a
// production resolver would answer it from the worker.
let innerResolverCalls: string[] = []
async function resolveInner(chainId: number, contract: string, selector: string) {
  innerResolverCalls.push(`${chainId}:${contract}:${selector}`)
  const hit = fixture!.definitions.find((d) =>
    Number(d.kind) === 1 && Number(d.chainId) === chainId &&
    (d.contractAddress ?? '').toLowerCase() === contract.toLowerCase() &&
    (d.selectorOrTypeHash ?? '').toLowerCase().replace(/^0x/, '') === selector.toLowerCase().replace(/^0x/, ''))
  return hit ? toDefinition(hit) : undefined
}

// ── Protobuf / HID helpers ─────────────────────────────────────────────

function protoFields(b: Uint8Array): Map<number, Array<number | Uint8Array>> {
  const out = new Map<number, Array<number | Uint8Array>>()
  let i = 0
  const varint = () => {
    let x = 0, mul = 1
    for (;;) {
      const c = b[i++]
      x += (c & 0x7f) * mul
      mul *= 128
      if (!(c & 0x80)) return x
    }
  }
  while (i < b.length) {
    const key = varint()
    const field = Math.floor(key / 8), wire = key & 7
    let v: number | Uint8Array
    if (wire === 0) v = varint()
    else if (wire === 2) { const l = varint(); v = b.slice(i, i + l); i += l }
    else if (wire === 5) { v = b.slice(i, i + 4); i += 4 }
    else if (wire === 1) { v = b.slice(i, i + 8); i += 8 }
    else throw new Error(`unsupported wire type ${wire}`)
    if (!out.has(field)) out.set(field, [])
    out.get(field)!.push(v)
  }
  return out
}
const text = (v: unknown) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : '')
const hex = (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : '')

function hidFrame(msgType: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const f = new Uint8Array(64)
  f[0] = 0x3f; f[1] = 0x23; f[2] = 0x23
  f[3] = (msgType >> 8) & 0xff; f[4] = msgType & 0xff
  f[8] = payload.length & 0xff
  f.set(payload, 9)
  return f
}
const DLD_YES = hidFrame(100, new Uint8Array([0x08, 0x01]))
const DEBUG_GET_STATE = hidFrame(MSG_DEBUG_GET_STATE)

// ── Emulator ───────────────────────────────────────────────────────────

function loadDylib() {
  if (!existsSync(DYLIB_PATH)) throw new Error(`Emulator dylib not found at ${DYLIB_PATH}`)
  return dlopen(DYLIB_PATH, {
    kkemu_init:     { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    kkemu_shutdown: { args: [], returns: FFIType.void },
    kkemu_write:    { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_read:     { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_start:    { args: [], returns: FFIType.i32 },
    kkemu_stop:     { args: [], returns: FFIType.void },
  })
}

type Screen = { code: number; title: string; body: string }
type DefinitionRequest = { kind: number; chainId: number; contract: string; selector: string; definitionId: string; offset: number; length: number; depth: number }

/** What one signing showed and asked for. */
class Recorder {
  buttons = 0
  screens: Screen[] = []
  definitionRequests: DefinitionRequest[] = []
  failure = ''
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class ReplayDelegate implements TransportDelegate {
  alive = true
  rec = new Recorder()
  private type = -1
  private want = 0
  private payload: number[] = []

  constructor(private ffi: ReturnType<typeof loadDylib>) {}
  async isOpened() { return true }
  async getDeviceID() { return 'emu-erc7730' }
  async connect() {}
  async tryConnectDebugLink() { return true }
  async disconnect() {}

  async writeChunk(buf: Uint8Array, debugLink?: boolean) {
    if (!this.alive) throw new Error('emulator was restarted')
    if (this.ffi.symbols.kkemu_write(ptr(buf), buf.length, debugLink ? 1 : 0) !== 0) throw new Error('kkemu_write failed')
  }

  private readRaw(iface: number): Uint8Array | null {
    const buf = new Uint8Array(64)
    return this.ffi.symbols.kkemu_read(ptr(buf), 64, iface) > 0 ? buf : null
  }

  async readChunk(debugLink?: boolean): Promise<Uint8Array> {
    const iface = debugLink ? 1 : 0
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (!this.alive) throw new Error('emulator was restarted')
      const buf = this.readRaw(iface)
      if (buf) {
        if (!debugLink) await this.observe(buf)
        return buf
      }
      await sleep(2)
    }
    throw new Error(`readChunk timeout (iface=${iface})`)
  }

  /** Reassemble main-interface messages; act on each complete one. */
  private async observe(buf: Uint8Array) {
    if (this.want === 0) {
      if (buf[0] !== 0x3f || buf[1] !== 0x23 || buf[2] !== 0x23) return
      this.type = (buf[3] << 8) | buf[4]
      this.want = ((buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8]) >>> 0
      this.payload = []
      const take = buf.subarray(9, 9 + Math.min(55, this.want))
      this.payload.push(...take)
      this.want -= take.length
    } else {
      const take = buf.subarray(1, 1 + Math.min(63, this.want))
      this.payload.push(...take)
      this.want -= take.length
    }
    if (this.want > 0) return
    const fields = protoFields(Uint8Array.from(this.payload))
    if (this.type === MSG_BUTTON_REQUEST) {
      this.rec.buttons++
      const [title, body] = await this.confirmText()
      this.rec.screens.push({ code: Number(fields.get(1)?.[0] ?? 0), title, body })
      this.ffi.symbols.kkemu_write(ptr(DLD_YES), 64, 1)
    } else if (this.type === MSG_DEFINITION_REQUEST) {
      const n = (f: number) => Number(fields.get(f)?.[0] ?? 0)
      this.rec.definitionRequests.push({
        kind: n(1), chainId: n(2), contract: hex(fields.get(3)?.[0]), selector: hex(fields.get(4)?.[0]),
        definitionId: hex(fields.get(5)?.[0]), offset: n(6), length: n(7), depth: n(8),
      })
    } else if (this.type === MSG_FAILURE) {
      this.rec.failure = text(fields.get(2)?.[0])
    }
  }

  /** Title and body of the confirmation on screen, read over DebugLink. */
  private async confirmText(): Promise<[string, string]> {
    while (this.readRaw(1)) {}
    this.ffi.symbols.kkemu_write(ptr(DEBUG_GET_STATE), 64, 1)
    const deadline = Date.now() + 10_000
    let want = -1
    const payload: number[] = []
    while (Date.now() < deadline && want !== 0) {
      const buf = this.readRaw(1)
      if (!buf) { await sleep(1); continue }
      if (want < 0) {
        if (buf[0] !== 0x3f || buf[1] !== 0x23 || buf[2] !== 0x23) continue
        if (((buf[3] << 8) | buf[4]) !== MSG_DEBUG_STATE) continue
        want = ((buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8]) >>> 0
        const take = buf.subarray(9, 9 + Math.min(55, want))
        payload.push(...take); want -= take.length
      } else {
        const take = buf.subarray(1, 1 + Math.min(63, want))
        payload.push(...take); want -= take.length
      }
    }
    if (want !== 0) return ['<no DebugLinkState>', '']
    const f = protoFields(Uint8Array.from(payload))
    return [text(f.get(16)?.[0]), text(f.get(17)?.[0])]
  }
}

let ffi: ReturnType<typeof loadDylib> | null = null
let flash: Buffer | null = null
let delegate: ReplayDelegate | null = null
let wallet: any = null
let address = ''
let advancedMode: boolean | undefined
let restarts = 0

function halt() {
  if (delegate) delegate.alive = false
  try { ffi?.symbols.kkemu_stop() } catch {}
  try { ffi?.symbols.kkemu_shutdown() } catch {}
  try { ffi?.close() } catch {}
  if (flash) flash.fill(0)
  ffi = null; flash = null; delegate = null; wallet = null
}

async function boot() {
  ffi = loadDylib()
  flash = Buffer.alloc(1048576, 0xff) // blank, in memory only
  if (ffi.symbols.kkemu_init(ptr(flash), 1048576) !== 0) throw new Error('kkemu_init failed')
  if (ffi.symbols.kkemu_start() !== 0) throw new Error('kkemu_start failed')
  const keyring = new core.Keyring()
  delegate = new ReplayDelegate(ffi)
  const transport = await Transport.create(keyring, delegate as any)
  await transport.connect()
  await transport.tryConnectDebugLink()
  const kk = await import('@keepkey/hdwallet-keepkey')
  wallet = kk.create(transport) as any
  keyring.add(wallet, 'emu-erc7730')
  await wallet.loadDevice({ mnemonic: TEST_MNEMONIC, pin: false, passphrase: false, skipChecksum: false })
  advancedMode = undefined
}

async function setAdvancedMode(on: boolean) {
  if (advancedMode === on) return
  await wallet.applyPolicy({ policyName: 'AdvancedMode', enabled: on })
  advancedMode = on
}

// ── One signing ────────────────────────────────────────────────────────

type Attempt = {
  ok: boolean; signature?: string; signer?: string; error?: string; ms: number
  buttons: number; screens: Screen[]; definitionRequests: DefinitionRequest[]; innerResolverCalls: string[]
}

function errorText(e: any): string {
  if (e?.message_enum === MSG_FAILURE) return String(e?.message?.message ?? 'Failure')
  if (e instanceof Error) return e.message
  return String(e)
}

/** Freeze what this signing saw; later screens (a policy change) go elsewhere. */
function seen(rec: Recorder) {
  if (delegate) delegate.rec = new Recorder()
  return { buttons: rec.buttons, screens: [...rec.screens], definitionRequests: [...rec.definitionRequests], innerResolverCalls: [...innerResolverCalls] }
}

async function attempt(fn: () => Promise<{ signature: string; signer?: string }>): Promise<Attempt> {
  const rec = (delegate!.rec = new Recorder())
  innerResolverCalls = []
  const t0 = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const out = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${SIGN_TIMEOUT_MS} ms`)), SIGN_TIMEOUT_MS) }),
    ])
    return { ok: true, ...out, ms: Date.now() - t0, ...seen(rec) }
  } catch (e) {
    const error = rec.failure && !errorText(e).includes(rec.failure) ? `${errorText(e)} [device: ${rec.failure}]` : errorText(e)
    const result: Attempt = { ok: false, error, ms: Date.now() - t0, ...seen(rec) }
    if (error.startsWith('timeout') || error.includes('readChunk timeout')) {
      // A wedged session must not leak into the next fixture.
      halt(); restarts++; await boot()
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

function signCalldata(fx: FxCalldata, erc7730?: core.ETHSignTx['erc7730']) {
  const t = fx.tx
  return async () => {
    const out = await wallet.ethSignTx({
      addressNList: PATH, chainId: t.chainId, nonce: t.nonce, gasLimit: t.gasLimit,
      maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas,
      to: t.to, value: t.value, data: t.data, erc7730,
    })
    const digest = utils.keccak256(utils.serializeTransaction({
      type: 2, chainId: t.chainId, nonce: Number(t.nonce), gasLimit: t.gasLimit,
      maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas,
      to: t.to, value: t.value, data: t.data,
    }))
    const signer = utils.recoverAddress(digest, { r: out.r, s: out.s, v: 27 + (Number(out.v) & 1) })
    return { signature: `${out.r}:${out.s}:${Number(out.v)}`, signer }
  }
}

function calldataCatalog(fx: FxCalldata, withInner = true): core.ETHSignTx['erc7730'] {
  return {
    primaryDefinitionId: fx.definitionId,
    definitions: [fx.definitionId, ...(withInner ? fx.innerDefinitionIds : [])].map(definition),
    ...(withInner ? { resolveInner } : {}),
  }
}

function signTyped(fx: FxEip712, erc7730?: core.ETHSignTypedData['erc7730']) {
  return async () => {
    const out = await wallet.ethSignTypedData({ addressNList: PATH, typedData: fx.typedData, erc7730 })
    let signer: string | undefined
    try {
      // ethers rejects mixed-case addresses with a bad checksum; case is not signed.
      const lower = (v: any): any => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase()
        : Array.isArray(v) ? v.map(lower) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, lower(x)])) : v
      const { EIP712Domain: _, ...types } = fx.typedData.types
      signer = utils.verifyTypedData(lower(fx.typedData.domain), types, lower(fx.typedData.message), out.signature)
    } catch (e) {
      signer = `unverifiable: ${errorText(e)}`
    }
    return { signature: out.signature, signer }
  }
}

// ── Results ────────────────────────────────────────────────────────────

type Row = { kind: 'calldata' | 'eip712' | 'negative'; id: string; description: string; base?: Attempt; def?: Attempt; note?: string; pass: boolean }
const rows: Row[] = []
const screenKey = (s: Screen) => `${s.title}\u0000${s.body}`

/** How often the baseline's screens come back when the definition is used. */
function reshow(base: Attempt, def: Attempt) {
  const counts = new Map<string, number>()
  for (const s of def.screens) counts.set(screenKey(s), (counts.get(screenKey(s)) ?? 0) + 1)
  const baseKeys = [...new Set(base.screens.map(screenKey))]
  const repeated = baseKeys.filter((k) => (counts.get(k) ?? 0) > 1)
  const maxRepeat = Math.max(0, ...baseKeys.map((k) => counts.get(k) ?? 0))
  const fieldPasses = def.definitionRequests.filter((r) => r.offset === 0).length
  return { baseScreens: base.buttons, defScreens: def.buttons, repeatedBaseScreens: repeated.length, distinctBaseScreens: baseKeys.length, maxRepeat, definitionRequests: def.definitionRequests.length, fieldPasses }
}

afterAll(() => {
  halt()
  if (!fixture) return
  const sum = (kind: Row['kind']) => {
    const r = rows.filter((x) => x.kind === kind)
    return { total: r.length, pass: r.filter((x) => x.pass).length, signed: r.filter((x) => x.def?.ok).length, baseSigned: r.filter((x) => x.base?.ok).length }
  }
  const summary = { dylib: DYLIB_PATH, firmware: fixture.firmware, restarts, calldata: sum('calldata'), eip712: sum('eip712'), negative: sum('negative') }
  console.log('\n=== ERC-7730 replay summary ===')
  console.log(JSON.stringify(summary, null, 1))
  for (const r of rows.filter((x) => !x.pass)) {
    console.log(`FAIL ${r.kind} ${r.id} | base: ${r.base?.ok ? 'ok' : r.base?.error} | def: ${r.def?.ok ? 'ok' : r.def?.error}${r.note ? ` | ${r.note}` : ''}`)
  }
  console.log('\n--- EIP-712 screens: without vs with definition ---')
  for (const r of rows.filter((x) => x.kind === 'eip712' && x.base?.ok && x.def?.ok)) {
    console.log(`${r.id.split('/').pop()} ${JSON.stringify(reshow(r.base!, r.def!))}`)
  }
  if (REPORT) {
    writeFileSync(REPORT, JSON.stringify({ summary, rows, eip712Screens: rows.filter((x) => x.kind === 'eip712' && x.base?.ok && x.def?.ok).map((r) => ({ id: r.id, ...reshow(r.base!, r.def!) })) }, null, 1))
    console.log(`report: ${REPORT}`)
  }
})

// ── Tests ──────────────────────────────────────────────────────────────

describe.skipIf(!fixture)('ERC-7730 replay on the stock 7.16 emulator', () => {
  test('boot a blank flash, load the test seed, firmware is 7.16.0', async () => {
    await boot()
    const features = await wallet.getFeatures()
    expect(features.initialized).toBe(true)
    expect(`${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`).toBe('7.16.0')
    address = (await wallet.ethGetAddress({ addressNList: PATH, showDisplay: false })).toLowerCase()
    console.log(`  firmware 7.16.0, signer ${address}, ${calldataCases.length} calldata + ${eip712Cases.length} EIP-712 cases`)
  }, 60_000)

  for (const fx of calldataCases) {
    test(`calldata ${fx.id}`, async () => {
      await setAdvancedMode(true)
      const base = await attempt(signCalldata(fx))
      await setAdvancedMode(false)
      const def = await attempt(signCalldata(fx, calldataCatalog(fx)))
      const pass = base.ok && def.ok && def.signature === base.signature && def.signer?.toLowerCase() === address && def.definitionRequests.length > 0
      rows.push({ kind: 'calldata', id: fx.id, description: fx.description, base, def, pass })
      expect(def.error).toBeUndefined()
      expect(base.error).toBeUndefined()
      expect(def.signature).toBe(base.signature!)
      expect(def.signer?.toLowerCase()).toBe(address)
      expect(def.definitionRequests.length).toBeGreaterThan(0)
    }, 2 * SIGN_TIMEOUT_MS + 30_000)
  }

  for (const fx of eip712Cases) {
    test(`eip712 ${fx.id}`, async () => {
      // Streaming typed data needs no AdvancedMode; keep it off for both runs
      // so the screen counts compare like for like.
      await setAdvancedMode(false)
      const base = await attempt(signTyped(fx))
      const def = await attempt(signTyped(fx, { primaryDefinitionId: fx.definitionId, definitions: [definition(fx.definitionId)] }))
      const signerOk = !def.signer || def.signer.startsWith('unverifiable') || def.signer.toLowerCase() === address
      const pass = base.ok && def.ok && def.signature === base.signature && def.definitionRequests.length > 0 && signerOk
      rows.push({ kind: 'eip712', id: fx.id, description: fx.description, base, def, pass })
      expect(def.error).toBeUndefined()
      expect(base.error).toBeUndefined()
      expect(def.signature).toBe(base.signature!)
      expect(def.definitionRequests.length).toBeGreaterThan(0)
      expect(signerOk).toBe(true)
    }, 2 * SIGN_TIMEOUT_MS + 30_000)
  }

  test('negative: a tampered envelope is refused at preload', async () => {
    const fx = calldataCases[0]
    if (!fx) return
    await setAdvancedMode(false)
    const good = definition(fx.definitionId)
    const bytes = Buffer.from(String(good.envelope), 'hex')
    bytes[bytes.length - 10] ^= 0x01 // inside the catalog signature
    const tampered = { ...good, envelope: bytes.toString('hex'), definitionId: createHash('sha256').update(bytes).digest('hex') }
    const def = await attempt(signCalldata(fx, { primaryDefinitionId: tampered.definitionId, definitions: [tampered] }))
    rows.push({ kind: 'negative', id: `tampered-envelope ${fx.id}`, description: fx.description, def, pass: !def.ok && def.definitionRequests.length === 0 })
    expect(def.ok).toBe(false)
    expect(def.definitionRequests.length).toBe(0)
  }, SIGN_TIMEOUT_MS + 30_000)

  test('negative: an embedded call without its inner definition fails', async () => {
    const used = rows.find((r) => r.kind === 'calldata' && r.pass && r.def!.definitionRequests.some((q) => q.depth === 1 && !q.definitionId))
    if (!used) { console.log('  no replayed fixture asked for an inner definition; skipped'); return }
    const fx = calldataCases.find((c) => c.id === used.id)!
    await setAdvancedMode(false)
    const def = await attempt(signCalldata(fx, calldataCatalog(fx, false)))
    rows.push({ kind: 'negative', id: `inner-miss ${fx.id}`, description: fx.description, def, pass: !def.ok && /Inner call cannot be clear-signed/.test(def.error ?? '') })
    expect(def.ok).toBe(false)
    expect(def.error).toContain('Inner call cannot be clear-signed')
  }, SIGN_TIMEOUT_MS + 30_000)
})
