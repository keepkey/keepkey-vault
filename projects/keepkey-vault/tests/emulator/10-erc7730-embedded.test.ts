/**
 * Test 10: ERC-7730 embedded calls through Desktop on a 7.17 emulator (UDP).
 *
 * Each real transaction (keepkey-firmware scripts/erc7730/
 * embedded_transactions.json: Safe creation, Safe execTransaction, SwapRouter02
 * multicall, 0x AllowanceHolder.exec into Settler, CoW EthFlow) is signed twice
 * on a fresh emulator flash:
 *   1. blind, AdvancedMode on, no definition;
 *   2. through Desktop's own path: the REST approval preview
 *      (prepareEvmTxSigningInfo -> resolveErc7730ForCall, which GETs
 *      /v1/erc7730/definition) and the sign step (signWithErc7730Fallback, which
 *      answers the device's inner-definition requests from the same service),
 *      with AdvancedMode off.
 * The two signatures must match, and every line of Desktop's card for the
 * call (describeErc7730Call over the definitions Desktop attached, read with
 * the fixture's test root) must appear, in order, on the device's screens.
 * A local HTTP server stands in for the ClearSign worker and serves the
 * fixture's TEST-root definitions.
 *
 * Talks to a kkemu binary over UDP only (no USB, no dylib): start it yourself
 * from a fresh run directory, with the fixture's test root, on a private port:
 *   KEEPKEY_UDP_PORT=<port> KK_CLEARSIGN_TEST_ROOT=<testRootPubkey> kkemu
 * then run with KK_EMU_UDP_PORT=<port> KK_ERC7730_717_FIXTURE=<fixture.json>.
 * Skipped unless both are set.
 */
import { createSocket, type Socket } from 'node:dgram'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, mock, test } from 'bun:test'
import * as core from '@keepkey/hdwallet-core'
import { Transport, type TransportDelegate } from '@keepkey/hdwallet-keepkey'
import { utils } from 'ethers'
import { TEST_MNEMONIC } from './harness'

const PORT = Number(process.env.KK_EMU_UDP_PORT || 0)
const FIXTURE = process.env.KK_ERC7730_717_FIXTURE
const PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
const MSG_FAILURE = 3
const MSG_BUTTON_REQUEST = 26
const MSG_DEBUG_STATE = 102
const MSG_DEFINITION_REQUEST = 1711

type FxDefinition = { name: string; definitionId: string; envelope: string; kind: string; chainId: number; contractAddress: string; selectorOrTypeHash: string }
type FxTx = { name: string; source: string; chain_id: number; to: string; value: string; data: string }
const fixture: { testRootPubkey: string; definitions: FxDefinition[]; transactions: FxTx[] } | null =
  PORT && FIXTURE ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null

// ── Wire helpers ───────────────────────────────────────────────────────

function protoFields(b: Uint8Array): Map<number, Array<number | Uint8Array>> {
  const out = new Map<number, Array<number | Uint8Array>>()
  let i = 0
  const varint = () => {
    let x = 0, mul = 1
    for (;;) { const c = b[i++]; x += (c & 0x7f) * mul; mul *= 128; if (!(c & 0x80)) return x }
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
const hexOf = (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : '')
function frame(msgType: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const f = new Uint8Array(64)
  f[0] = 0x3f; f[1] = 0x23; f[2] = 0x23
  f[3] = (msgType >> 8) & 0xff; f[4] = msgType & 0xff
  f[8] = payload.length & 0xff
  f.set(payload, 9)
  return f
}
const DLD_YES = frame(100, new Uint8Array([0x08, 0x01]))
const DEBUG_GET_STATE = frame(101)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One UDP socket per interface: main on PORT, DebugLink on PORT + 1. */
class Channel {
  queue: Uint8Array[] = []
  socket: Socket
  constructor(public port: number) {
    this.socket = createSocket('udp4')
    this.socket.on('message', (msg) => this.queue.push(Uint8Array.from(msg)))
  }
  send(buf: Uint8Array) { this.socket.send(buf, this.port, '127.0.0.1') }
  async next(timeoutMs: number): Promise<Uint8Array | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const b = this.queue.shift()
      if (b) return b
      await sleep(1)
    }
    return null
  }
  close() { try { this.socket.close() } catch {} }
}

type Screen = { title: string; body: string }
type DefinitionRequest = { contract: string; selector: string; definitionId: string; offset: number; depth: number }
class Recorder { screens: Screen[] = []; definitionRequests: DefinitionRequest[] = []; failure = '' }

class UdpDelegate implements TransportDelegate {
  main = new Channel(PORT)
  debug = new Channel(PORT + 1)
  rec = new Recorder()
  private type = -1
  private want = 0
  private payload: number[] = []
  async isOpened() { return true }
  async getDeviceID() { return 'emu-udp-717' }
  async connect() {}
  async tryConnectDebugLink() { return true }
  async disconnect() { this.main.close(); this.debug.close() }
  async writeChunk(buf: Uint8Array, debugLink?: boolean) { (debugLink ? this.debug : this.main).send(buf) }
  async readChunk(debugLink?: boolean): Promise<Uint8Array> {
    const buf = await (debugLink ? this.debug : this.main).next(30_000)
    if (!buf) throw new Error(`readChunk timeout (debug=${!!debugLink})`)
    if (!debugLink) await this.observe(buf)
    return buf
  }
  /** Reassemble main-interface messages: press yes on each screen (reading it
   *  over DebugLink first), and record each definition request. */
  private async observe(buf: Uint8Array) {
    if (this.want === 0) {
      if (buf[0] !== 0x3f || buf[1] !== 0x23 || buf[2] !== 0x23) return
      this.type = (buf[3] << 8) | buf[4]
      this.want = ((buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8]) >>> 0
      this.payload = [...buf.subarray(9, 9 + Math.min(55, this.want))]
      this.want -= Math.min(55, this.want)
    } else {
      const take = buf.subarray(1, 1 + Math.min(63, this.want))
      this.payload.push(...take)
      this.want -= take.length
    }
    if (this.want > 0) return
    const fields = protoFields(Uint8Array.from(this.payload))
    if (this.type === MSG_BUTTON_REQUEST) {
      this.rec.screens.push(await this.screen())
      this.debug.send(DLD_YES)
    } else if (this.type === MSG_DEFINITION_REQUEST) {
      const n = (f: number) => Number(fields.get(f)?.[0] ?? 0)
      this.rec.definitionRequests.push({
        contract: hexOf(fields.get(3)?.[0]), selector: hexOf(fields.get(4)?.[0]), definitionId: hexOf(fields.get(5)?.[0]), offset: n(6), depth: n(8),
      })
    } else if (this.type === MSG_FAILURE) {
      this.rec.failure = text(fields.get(2)?.[0])
    }
  }
  private async screen(): Promise<Screen> {
    this.debug.queue.length = 0
    this.debug.send(DEBUG_GET_STATE)
    let want = -1
    const payload: number[] = []
    while (want !== 0) {
      const buf = await this.debug.next(10_000)
      if (!buf) return { title: '<no DebugLinkState>', body: '' }
      if (want < 0) {
        if (buf[0] !== 0x3f || buf[1] !== 0x23 || buf[2] !== 0x23 || ((buf[3] << 8) | buf[4]) !== MSG_DEBUG_STATE) continue
        want = ((buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8]) >>> 0
        payload.push(...buf.subarray(9, 9 + Math.min(55, want))); want -= Math.min(55, want)
      } else {
        const take = buf.subarray(1, 1 + Math.min(63, want))
        payload.push(...take); want -= take.length
      }
    }
    const f = protoFields(Uint8Array.from(payload))
    return { title: text(f.get(16)?.[0]), body: text(f.get(17)?.[0]) }
  }
}

// ── Desktop, against a stand-in worker ─────────────────────────────────

// db.ts reads electrobun's userData at import: a throwaway directory.
const dataDir = fixture ? mkdtempSync(join(tmpdir(), 'vault-erc7730-717-')) : ''
if (dataDir) mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dataDir } } }))

const served: string[] = []
let server: ReturnType<typeof Bun.serve> | null = null
function startWorker(): string {
  const notListed = () => Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/v1/erc7730/definition' || url.searchParams.get('kind') !== 'calldata') return notListed()
      const key = `${Number(url.searchParams.get('chainId'))}:${String(url.searchParams.get('contract')).toLowerCase()}:${String(url.searchParams.get('selector')).toLowerCase()}`
      served.push(key)
      const hit = fixture!.definitions.find((d) => `${d.chainId}:${d.contractAddress}:${d.selectorOrTypeHash}` === key)
      return hit ? Response.json(hit) : notListed()
    },
  })
  return `http://127.0.0.1:${server.port}`
}

let delegate: UdpDelegate
let wallet: any
let address = ''
let firmwareVersion = ''
let capabilities: number[] = []
let advancedMode: boolean | undefined
let mods: {
  prepare: typeof import('../../src/bun/evm-presign-report').prepareEvmTxSigningInfo
  resolver: typeof import('../../src/bun/erc7730-resolver')
  describe: typeof import('../../src/bun/erc7730-describe').describeErc7730Call
}

async function setAdvancedMode(on: boolean) {
  if (advancedMode === on) return
  await wallet.applyPolicy({ policyName: 'AdvancedMode', enabled: on })
  advancedMode = on
}

const GAS = { nonce: '0x0', gasLimit: '0x1e8480', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x3b9aca00' }

async function sign(tx: FxTx, send: (msg: any) => Promise<any>) {
  const rec = (delegate.rec = new Recorder())
  const msg = { addressNList: PATH, chainId: tx.chain_id, to: tx.to, value: tx.value, data: tx.data, ...GAS }
  try {
    const out = await send(msg)
    const digest = utils.keccak256(utils.serializeTransaction({
      type: 2, chainId: tx.chain_id, nonce: 0, gasLimit: GAS.gasLimit, maxFeePerGas: GAS.maxFeePerGas,
      maxPriorityFeePerGas: GAS.maxPriorityFeePerGas, to: tx.to, value: tx.value, data: tx.data,
    }))
    const signer = utils.recoverAddress(digest, { r: out.r, s: out.s, v: 27 + (Number(out.v) & 1) }).toLowerCase()
    return { ok: true, signature: `${out.r}:${out.s}:${Number(out.v)}`, signer, rec }
  } catch (e: any) {
    return { ok: false, error: String(e?.message?.message ?? e?.message ?? e), rec }
  }
}

/** The REST path: preview decides the definition; sign sends exactly it. */
async function desktopSign(tx: FxTx) {
  const info: any = { id: tx.name, method: 'eth_signTransaction', appName: 'erc7730-717', from: address, to: tx.to, value: tx.value, data: tx.data, chainId: tx.chain_id, firmwareVersion }
  await mods.prepare(info, { from: address, to: tx.to, data: tx.data, value: tx.value, nonce: GAS.nonce, gas: GAS.gasLimit, maxFeePerGas: GAS.maxFeePerGas, maxPriorityFeePerGas: GAS.maxPriorityFeePerGas }, firmwareVersion, capabilities)
  await setAdvancedMode(info.needsBlindSigning === true)
  let fellBack: string | undefined
  const result = await sign(tx, (msg) => mods.resolver.signWithErc7730Fallback(
    info.erc7730 ? { ...msg, erc7730: info.erc7730 } : msg,
    (m: any) => wallet.ethSignTx(m),
    async (_plain, reason) => { fellBack = reason; await setAdvancedMode(true) },
  ))
  // The card a production-signed definition gets, read here with the fixture's test root.
  const card = info.erc7730 && mods.describe(info.erc7730.definitions[0].envelope,
    { chainId: tx.chain_id, to: tx.to, data: tx.data, value: tx.value, from: address, firmwareVersion }, info.erc7730.definitions, fixture!.testRootPubkey)
  return { result, attached: !!info.erc7730, needsBlindSigning: info.needsBlindSigning === true, fellBack, card }
}

/** Card lines missing from the device's screens, read in order (pages joined, wrapping ignored). */
function cardNotOnDevice(card: { intent: string; fields: Array<{ label: string; value: string }> }, screens: Screen[]): string[] {
  const squash = (t: string) => t.replace(/\s+/g, '')
  const stream = squash(screens.map((s) => s.body).join(''))
  const missing: string[] = []
  let at = 0
  const pieces = [card.intent, ...card.fields.flatMap((f) => f.label === 'Inner action' ? [f.value] : [`${f.label}:`, ...f.value.split('\n')])]
  for (const piece of pieces) {
    const i = stream.indexOf(squash(piece), at)
    if (i < 0) missing.push(piece)
    else at = i + squash(piece).length
  }
  return missing
}

const shown = (screens: Screen[]) => screens.map((s) => `${s.title} | ${s.body}`.replace(/\n/g, ' / '))

afterAll(async () => {
  try { await delegate?.disconnect() } catch {}
  try { server?.stop(true) } catch {}
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

// What Desktop must do with each transaction on 7.17 (AdvancedMode off).
const EXPECT: Record<string, { outcome: 'clear-signed' | 'not-attached'; innerDepths?: number[]; screen?: RegExp }> = {
  safe_create: { outcome: 'clear-signed', innerDepths: [1], screen: /Setup Safe/ },
  // setup()'s module DELEGATECALLs, which 7.17 refuses to clear-sign. Desktop
  // sees it in the calldata and attaches nothing: the normal review, once.
  safe_create_l2_setup: { outcome: 'not-attached', screen: /Ethereum Data Hash/ },
  safe_exec_transfer: { outcome: 'clear-signed', innerDepths: [1], screen: /NOT this wallet/ },
  safe_exec_native: { outcome: 'clear-signed' },
  safe_exec_self: { outcome: 'clear-signed', innerDepths: [1], screen: /Add signer/ },
  router02_multicall: { outcome: 'clear-signed', innerDepths: [1], screen: /Swap exact input/ },
  zeroex_allowance_holder: { outcome: 'clear-signed', innerDepths: [1], screen: /Receive at least/ },
  cow_ethflow: { outcome: 'clear-signed', screen: /Valid until/ },
  // Two levels: Safe -> multicall -> each step.
  safe_exec_multicall: { outcome: 'clear-signed', innerDepths: [1, 2], screen: /Swap exact input/ },
}

describe.skipIf(!fixture)('ERC-7730 embedded calls through Desktop on a 7.17 emulator (UDP)', () => {
  test('boot over UDP, stand-in worker, firmware 7.17', async () => {
    process.env.CLEARSIGN_SERVICE_URL = startWorker()
    const envelope = await import('../../src/shared/certified-evm-envelope')
    // The emulator was started with the fixture's test root: Desktop attaches only what verifies to it.
    envelope.configureProductionRootTrust(() => true, () => fixture!.testRootPubkey)
    mods = {
      prepare: (await import('../../src/bun/evm-presign-report')).prepareEvmTxSigningInfo,
      resolver: await import('../../src/bun/erc7730-resolver'),
      describe: (await import('../../src/bun/erc7730-describe')).describeErc7730Call,
    }
    delegate = new UdpDelegate()
    const keyring = new core.Keyring()
    const transport = await Transport.create(keyring, delegate as any)
    await transport.connect()
    await transport.tryConnectDebugLink()
    const kk = await import('@keepkey/hdwallet-keepkey')
    wallet = kk.create(transport) as any
    keyring.add(wallet, 'emu-udp-717')
    await wallet.wipe()
    await wallet.loadDevice({ mnemonic: TEST_MNEMONIC, pin: false, passphrase: false, skipChecksum: false })
    const features = await wallet.getFeatures()
    firmwareVersion = `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`
    capabilities = Array.isArray(features.capabilitiesList) ? [...features.capabilitiesList] : []
    address = (await wallet.ethGetAddress({ addressNList: PATH, showDisplay: false })).toLowerCase()
    console.log(`  firmware ${firmwareVersion}, capabilities [${capabilities}], signer ${address}`)
    expect(firmwareVersion).toBe('7.17.0')
    expect(capabilities).toContain(4)
  }, 60_000)

  for (const tx of fixture?.transactions ?? []) {
    test(`${tx.name}: ${tx.source}`, async () => {
      const want = EXPECT[tx.name]
      expect(want).toBeDefined()
      await setAdvancedMode(true)
      const blind = await sign(tx, (msg) => wallet.ethSignTx(msg))
      const d = await desktopSign(tx)
      const r = d.result
      const depths = [...new Set(r.rec.definitionRequests.filter((q) => q.depth > 0).map((q) => q.depth))].sort()
      console.log(`  ${tx.name}: ${d.attached ? (d.fellBack ? `fell back (${d.fellBack})` : 'clear-signed') : 'NOT attached'}, inner depths [${depths}], AdvancedMode at sign ${d.needsBlindSigning}`)
      for (const s of shown(r.rec.screens)) console.log(`    ${s}`)
      expect(blind.ok).toBe(true)
      expect(r.ok).toBe(true)
      expect(r.signature).toBe(blind.signature!)
      expect(r.signer).toBe(address)
      expect(d.fellBack).toBeUndefined()
      if (want.outcome === 'clear-signed') {
        expect(d.attached).toBe(true)
        expect(d.needsBlindSigning).toBe(false)
        expect(r.rec.screens.some((s) => /Verified by KeepKey/.test(`${s.title} ${s.body}`))).toBe(true)
        // The card says what the device shows, line for line.
        expect(d.card).toBeDefined()
        for (const f of d.card!.fields) console.log(`    card: ${'  '.repeat(f.depth ?? 0)}${f.label} | ${f.value.replace(/\n/g, ' / ')}`)
        expect(cardNotOnDevice(d.card!, r.rec.screens)).toEqual([])
      } else {
        expect(d.attached).toBe(false)
        expect(d.needsBlindSigning).toBe(true)
        expect(r.rec.definitionRequests).toEqual([])
      }
      expect(depths).toEqual(want.innerDepths ?? [])
      if (want.screen) expect(shown(r.rec.screens).some((s) => want.screen!.test(s))).toBe(true)
    }, 300_000)
  }
})
