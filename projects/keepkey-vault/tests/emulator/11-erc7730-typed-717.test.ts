/**
 * Test 11: typed-data ERC-7730 through Desktop's own path on a 7.17 emulator.
 *
 * Permit2 PermitTransferFrom requests (a real 0x quote on Base, and the
 * python-keepkey corpus case on Ethereum) are each signed twice on a kkemu
 * built from keepkey-firmware alpha (7.17.0, typed-data show-once #1025):
 *   1. hdwallet alone, no definition: the streamed review;
 *   2. Desktop's signing gate (attachErc7730TypedDefinition GETs the stand-in
 *      ClearSign service and builds the approval card), then the sign
 *      handler's step: exactly the card's definition, signWithErc7730Fallback.
 * Desktop must attach the definition, the device must use it and show the
 * definition's fields as the card states them, and the signature must not
 * change. Both reviews are
 * printed with their screen counts. The same request with the firmware
 * reported as 7.16.0 must attach nothing.
 *
 * Talks UDP only (never USB): kkemu on 127.0.0.1:KK_EMU_UDP_PORT, its DebugLink
 * on the next port. Start kkemu from an empty directory (blank flash) with
 * KK_CLEARSIGN_TEST_ROOT set to the fixture's test root:
 *
 *   KEEPKEY_UDP_PORT=13744 KK_CLEARSIGN_TEST_ROOT=<root> kkemu
 *   KK_FORCE_UDP=1 KK_EMU_UDP_PORT=13744 KK_ERC7730_TYPED_FIXTURE=<signed-catalog-4-TEST.json> \
 *     bun test tests/emulator/11-erc7730-typed-717.test.ts
 *
 * The fixture is the issuer's TEST-root dry run of batch 4 (same programs as
 * production, TEST certificates). Skipped unless both variables are set.
 */
import dgram from 'node:dgram'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterAll, describe, expect, test } from 'bun:test'
import * as core from '@keepkey/hdwallet-core'
import { Transport, type TransportDelegate } from '@keepkey/hdwallet-keepkey'
import { TEST_MNEMONIC } from './harness'
import requestFixture from '../../src/bun/erc7730-typed-data.fixtures.json'
import { describeErc7730TypedData } from '../../src/bun/erc7730-describe'

const PORT = Number(process.env.KK_EMU_UDP_PORT || 0)
const CATALOG = process.env.KK_ERC7730_TYPED_FIXTURE
const PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
const TYPEHASH = '939c21a48a8dbe3a9a2404a1d46691e4d39f6583d6ec6b35714604c986d80106'
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'

const MSG_FAILURE = 3
const MSG_BUTTON_REQUEST = 26
const MSG_DEBUG_STATE = 102
const MSG_DEFINITION_REQUEST = 1711

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
function frame(msgType: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const f = new Uint8Array(64)
  f[0] = 0x3f; f[1] = 0x23; f[2] = 0x23
  f[3] = (msgType >> 8) & 0xff; f[4] = msgType & 0xff
  f[8] = payload.length & 0xff
  f.set(payload, 9)
  return f
}
const DEBUG_DECISION_YES = frame(100, new Uint8Array([0x08, 0x01]))
const DEBUG_GET_STATE = frame(101)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Run = { screens: Array<{ title: string; body: string }>; definitionRequests: number; failure: string }

/** hdwallet over kkemu's UDP ports; presses every confirm and records its text. */
class UdpDelegate implements TransportDelegate {
  run: Run = { screens: [], definitionRequests: 0, failure: '' }
  private sockets = [dgram.createSocket('udp4'), dgram.createSocket('udp4')]
  private queues: Uint8Array[][] = [[], []]
  private type = -1
  private want = 0
  private payload: number[] = []

  constructor(private port: number) {
    this.sockets.forEach((s, i) => s.on('message', (m) => this.queues[i].push(new Uint8Array(m))))
  }
  close() { this.sockets.forEach((s) => s.close()) }
  async isOpened() { return true }
  async getDeviceID() { return 'kkemu-udp' }
  async connect() {}
  async tryConnectDebugLink() { return true }
  async disconnect() {}

  private send(iface: number, buf: Uint8Array) {
    return new Promise<void>((resolve, reject) => this.sockets[iface].send(buf, this.port + iface, '127.0.0.1', (e) => (e ? reject(e) : resolve())))
  }
  private async next(iface: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const buf = this.queues[iface].shift()
      if (buf) return buf
      await sleep(2)
    }
    throw new Error(`UDP read timeout (port ${this.port + iface})`)
  }
  async writeChunk(buf: Uint8Array, debugLink?: boolean) { await this.send(debugLink ? 1 : 0, buf) }
  async readChunk(debugLink?: boolean): Promise<Uint8Array> {
    const buf = await this.next(debugLink ? 1 : 0, 60_000)
    if (!debugLink) await this.observe(buf)
    return buf
  }

  private async observe(buf: Uint8Array) {
    if (this.want === 0) {
      if (buf[0] !== 0x3f || buf[1] !== 0x23 || buf[2] !== 0x23) return
      this.type = (buf[3] << 8) | buf[4]
      this.want = ((buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8]) >>> 0
      this.payload = []
      const take = buf.subarray(9, 9 + Math.min(55, this.want))
      this.payload.push(...take); this.want -= take.length
    } else {
      const take = buf.subarray(1, 1 + Math.min(63, this.want))
      this.payload.push(...take); this.want -= take.length
    }
    if (this.want > 0) return
    const fields = protoFields(Uint8Array.from(this.payload))
    if (this.type === MSG_BUTTON_REQUEST) {
      this.run.screens.push(await this.confirmText())
      await this.send(1, DEBUG_DECISION_YES)
    } else if (this.type === MSG_DEFINITION_REQUEST) {
      this.run.definitionRequests++
    } else if (this.type === MSG_FAILURE) {
      this.run.failure = text(fields.get(2)?.[0])
    }
  }

  private async confirmText(): Promise<{ title: string; body: string }> {
    this.queues[1].length = 0
    await this.send(1, DEBUG_GET_STATE)
    let want = -1
    const payload: number[] = []
    while (want !== 0) {
      const buf = await this.next(1, 10_000)
      if (want < 0) {
        if (buf[0] !== 0x3f || buf[1] !== 0x23 || buf[2] !== 0x23 || ((buf[3] << 8) | buf[4]) !== MSG_DEBUG_STATE) continue
        want = ((buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8]) >>> 0
        const take = buf.subarray(9, 9 + Math.min(55, want))
        payload.push(...take); want -= take.length
      } else {
        const take = buf.subarray(1, 1 + Math.min(63, want))
        payload.push(...take); want -= take.length
      }
    }
    const f = protoFields(Uint8Array.from(payload))
    return { title: text(f.get(16)?.[0]), body: text(f.get(17)?.[0]) }
  }
}

/** The TEST-signed PermitTransferFrom leaf for this chain, as the service would answer it. */
function testDefinition(chainId: number) {
  const catalog = JSON.parse(readFileSync(CATALOG!, 'utf8'))
  const leaf = catalog.entries.flatMap((e: any) => e.programs ?? [])
    .find((p: any) => p.chain === chainId && p.kind === 'eip712' && p.contract === PERMIT2 && p.selector_or_type_hash === TYPEHASH)
  if (!leaf) throw new Error(`fixture has no PermitTransferFrom leaf on chain ${chainId}`)
  const envelope = Buffer.from(leaf.certified_envelope_hex, 'hex')
  return {
    definitionId: `0x${createHash('sha256').update(envelope).digest('hex')}`, envelope: `0x${leaf.certified_envelope_hex}`,
    kind: 'eip712', chainId, contractAddress: PERMIT2, selectorOrTypeHash: `0x${TYPEHASH}`,
  }
}

/** The real 0x quote (Base, WETH), and the Permit2 PermitTransferFrom of python-keepkey's
 *  EIP-712 corpus (Ethereum, USDC to the Universal Router; built from Permit2's PermitHash.sol). */
const CASES = [
  { id: '0x quote, Base WETH', typedData: requestFixture.typedData },
  {
    id: 'corpus, Ethereum USDC',
    typedData: {
      types: {
        EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
        TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
      },
      primaryType: 'PermitTransferFrom',
      domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      message: { permitted: { token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', amount: '250000000' }, spender: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', nonce: '1997', deadline: '1775803746' },
    },
  },
]

const enabled = !!PORT && !!CATALOG
let delegate: UdpDelegate | null = null
let wallet: any = null
let server: ReturnType<typeof Bun.serve> | null = null
let lookups: string[] = []
afterAll(() => { delegate?.close(); server?.stop(true) })

describe.skipIf(!enabled)('typed-data ERC-7730 through Desktop on a 7.17 emulator (UDP)', () => {
  let firmwareVersion = ''
  let capabilities: number[] = []
  let resolver: typeof import('../../src/bun/erc7730-resolver')
  let preview: typeof import('../../src/bun/evm-signing-preview')

  test('kkemu answers over UDP, loads the test seed, reports 7.17 with capability 4', async () => {
    const definitions = new Map([1, 8453].map((c) => [String(c), testDefinition(c)]))
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname !== '/v1/erc7730/definition') return new Response('not found', { status: 404 })
        lookups.push(url.search)
        const definition = definitions.get(url.searchParams.get('chainId') || '')
        return definition && url.searchParams.get('kind') === 'eip712' && url.searchParams.get('typeHash') === `0x${TYPEHASH}`
          && url.searchParams.get('contract') === PERMIT2
          ? Response.json(definition) : Response.json({ code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
      },
    })
    process.env.CLEARSIGN_SERVICE_URL = `http://127.0.0.1:${server.port}`
    // As in 09-erc7730: an emulator started with a test root trusts that root.
    ;(await import('../../src/shared/certified-evm-envelope')).configureProductionRootTrust(() => true)
    resolver = await import('../../src/bun/erc7730-resolver')
    preview = await import('../../src/bun/evm-signing-preview')
    resolver.forgetRefusedErc7730Definitions()

    const keyring = new core.Keyring()
    delegate = new UdpDelegate(PORT)
    const transport = await Transport.create(keyring, delegate as any)
    await transport.connect()
    await transport.tryConnectDebugLink()
    const kk = await import('@keepkey/hdwallet-keepkey')
    wallet = kk.create(transport) as any
    keyring.add(wallet, 'kkemu-udp')
    const before = await wallet.getFeatures()
    if (!before.initialized) await wallet.loadDevice({ mnemonic: TEST_MNEMONIC, pin: false, passphrase: false, skipChecksum: false })
    const features = await wallet.getFeatures()
    firmwareVersion = `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`
    capabilities = [...(features.capabilitiesList ?? [])]
    console.log(`  kkemu UDP ${PORT}: firmware ${firmwareVersion}, capabilities [${capabilities}], service ${process.env.CLEARSIGN_SERVICE_URL}`)
    expect(features.initialized).toBe(true)
    expect(firmwareVersion).toBe('7.17.0')
    expect(capabilities).toContain(4)
  }, 60_000)

  for (const c of CASES) {
    test(`${c.id}: Desktop on 7.17 attaches the service definition, the device uses it, same signature`, async () => {
      delegate!.run = { screens: [], definitionRequests: 0, failure: '' }
      const plain = await wallet.ethSignTypedData({ addressNList: PATH, typedData: c.typedData })
      const streamed = delegate!.run
      expect(streamed.definitionRequests).toBe(0)
      expect(streamed.failure).toBe('')

      lookups = []
      const chainId = Number(c.typedData.domain.chainId)
      const from = (await wallet.ethGetAddress({ addressNList: PATH, showDisplay: false })) as string
      const card: any = { id: 'card', method: '/eth/sign-typed-data', appName: 'dapp', chain: 'eth' }
      expect(await preview.attachErc7730TypedDefinition(card, c.typedData, firmwareVersion, capabilities, from)).toBe(true)
      expect(card.erc7730?.primaryDefinitionId).toBe(testDefinition(chainId).definitionId)
      expect(lookups).toEqual([`?kind=eip712&chainId=${chainId}&contract=${PERMIT2}&typeHash=0x${TYPEHASH}`])
      const params = { addressNList: PATH, typedData: c.typedData, erc7730: card.erc7730 }
      delegate!.run = { screens: [], definitionRequests: 0, failure: '' }
      const sent: boolean[] = []
      const out = await resolver.signWithErc7730Fallback(params, (p: any) => { sent.push(!!p.erc7730); return wallet.ethSignTypedData(p) })
      const run = delegate!.run

      for (const [name, r] of [['streamed', streamed], ['with definition', run]] as const) {
        console.log(`  ${c.id}, ${name}: ${r.screens.length} screens${r.definitionRequests ? `, ${r.definitionRequests} definition requests` : ''}`)
        for (const s of r.screens) console.log(`    | ${s.title} | ${s.body.replace(/\n/g, ' / ')}`)
      }
      expect(sent).toEqual([true]) // no fallback: the device took the definition
      expect(run.definitionRequests).toBeGreaterThan(0)
      expect(run.failure).toBe('')
      expect(out.signature).toBe(plain.signature)
      expect(run.screens.some((s) => s.title === 'Verified by KeepKey')).toBe(true)
      // Show-once (firmware #1025): no screen repeats. A 7.17.0 alpha built
      // before it re-shows every value on each field pass; Desktop does not
      // support those builds (shared/erc7730-support).
      const screens = run.screens.map((s) => `${s.title}|${s.body}`)
      expect(new Set(screens).size).toBe(screens.length)
      for (const label of ['Spender:', 'Amount:', 'Deadline:']) expect(run.screens.some((s) => s.body.startsWith(label))).toBe(true)
      // The card states what the device showed: its intent and each field's
      // value. The card describes only a production-signed envelope, so read
      // the production envelope of the same program (the Base request fixture;
      // the TEST dry run signs identical programs under a TEST root).
      expect(card.erc7730Description).toBeUndefined()
      if (chainId !== Number(requestFixture.typedData.domain.chainId)) return
      const program = (hex: string) => { const b = Buffer.from(hex.replace(/^0x/, ''), 'hex'); return b.subarray(10, 10 + b.readUInt32BE(6)).toString('hex') }
      expect(program(requestFixture.definition.envelope)).toBe(program(card.erc7730.definitions[0].envelope))
      const d = describeErc7730TypedData(requestFixture.definition.envelope, c.typedData, from)!
      console.log(`  card: ${d?.intent} | ${d?.fields.map((f: any) => `${f.label}: ${f.value.replace(/\n/g, ' / ')}`).join(' | ')}`)
      expect(d?.intent).toBeTruthy()
      expect(run.screens.some((s) => `${s.title} ${s.body}`.includes(d.intent))).toBe(true)
      // A value too long for one screen continues on the next (1/2, 2/2).
      const shown = run.screens.map((s) => s.body).join('').replace(/\s+/g, '')
      for (const f of d.fields) expect(shown).toContain(`${f.label}:${f.value}`.replace(/\s+/g, ''))
    }, 240_000)
  }

  test('the same request with the firmware reported as 7.16.0: nothing looked up or attached', async () => {
    lookups = []
    const params = await resolver.withErc7730TypedData({ addressNList: PATH, typedData: requestFixture.typedData }, { firmwareVersion: '7.16.0', capabilities })
    expect(params.erc7730).toBeUndefined()
    expect(lookups).toEqual([])
  })
})
