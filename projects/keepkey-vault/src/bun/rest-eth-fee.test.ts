/**
 * REST /eth/sign-transaction when the request carries no fee (dapps leave it to
 * the wallet). Bodies are the 2026-10-30 emulator legs A1 (swaps.pro CoW
 * approve, Ethereum) and A5 (Permit2 approve, Base). Desktop used to send
 * gasPrice '0x0'; firmware 7.14.2 hashed it as a 0x00 byte and the signature
 * recovered to another address. The fake device hashes the way each firmware
 * does (7.14.2 as hdwallet's bytes, 7.16 strips integer fields: ethereum.c
 * hash_rlp_bytes_stripped) and signs with a test key. Pioneer is stubbed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BigNumber, Wallet, utils } from 'ethers'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-rest-eth-fee-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('./db')
let gasPriceAnswer: () => any
const gasPriceAsked: string[] = []
const pioneer = { GetGasPriceByNetwork: async ({ networkId }: { networkId: string }) => { gasPriceAsked.push(networkId); return gasPriceAnswer() } }
const realPioneer = await import('./pioneer')
mock.module('./pioneer', () => ({ ...realPioneer, getPioneer: async () => pioneer }))
const { startRestApi } = await import('./rest-api')

const KEY = new Wallet('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318')
const PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
// Emulator leg A1 @7.14.2: approvals/runs/fw-7.14.2/out/A1-approve-usdc-cow-vaultrelayer.am-off.json
const A1 = {
  from: KEY.address, to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', value: '0x0',
  data: '0x095ea7b3000000000000000000000000c92e8bdf79f0507f65a392b0ab4667716bfe011000000000000000000000000000000000000000000000000000000005d21dba00',
  chainId: '0x1', nonce: '0x7', gas: '0xea60',
}
// Emulator leg A5 @7.14.2: approvals/runs/fw-7.14.2/out/A5-approve-base-usdc-unlimited-permit2.am-on.json
const A5 = {
  from: KEY.address, to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', value: '0x0',
  data: '0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  chainId: '0x2105', nonce: '0x0', gas: '0x11940',
}

type Fw = '7.14.2' | '7.16.0'
const bytes = (h: string) => utils.arrayify(h, { hexPad: 'left' }) // hdwallet core.arrayify pads odd hex
const strip = (b: Uint8Array) => { const i = b.findIndex((x) => x !== 0); return i < 0 ? new Uint8Array() : b.slice(i) }
const big = (h: string) => BigNumber.from(h === '0x' ? 0 : h)

/** The legacy EIP-155 hash the device signs, from the message hdwallet gets. */
function deviceHash(m: any, fw: Fw) {
  const int = (h: string) => (fw === '7.14.2' ? bytes(h) : strip(bytes(h)))
  return utils.keccak256(utils.RLP.encode([
    strip(bytes(m.nonce)), // hdwallet strips the nonce
    int(m.gasPrice), int(m.gasLimit), bytes(m.to),
    /^0x0*$/.test(m.value) ? new Uint8Array() : int(m.value), // hdwallet omits a zero value
    bytes(m.data), strip(bytes(utils.hexlify(m.chainId))), new Uint8Array(), new Uint8Array(),
  ]))
}

function deviceSign(m: any, fw: Fw) {
  const sig = KEY._signingKey().signDigest(deviceHash(m, fw))
  // hdwallet serializes canonically (ethereumjs), whatever the device hashed.
  const serialized = utils.serializeTransaction({
    nonce: big(m.nonce).toNumber(), gasPrice: big(m.gasPrice), gasLimit: big(m.gasLimit),
    to: m.to, value: big(m.value), data: m.data, chainId: m.chainId,
  }, { r: sig.r, s: sig.s, v: sig.recoveryParam + m.chainId * 2 + 35 })
  return { r: sig.r, s: sig.s, v: sig.recoveryParam + m.chainId * 2 + 35, serialized }
}

const originalFetch = globalThis.fetch
beforeAll(() => {
  db.initDb()
  // Simulation goes to a closed local port, not Pioneer.
  db.setSetting('evm_simulation_rpc_urls', JSON.stringify({ 1: 'http://127.0.0.1:9/', 8453: 'http://127.0.0.1:9/' }))
})
afterAll(() => {
  mock.module('./pioneer', () => realPioneer) // module mocks are process-wide under make test-unit
  db.closeDb(); rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  gasPriceAsked.length = 0
  gasPriceAnswer = () => ({ data: { slow: 9, average: 12.5, fast: 20 } })
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, init)
    return Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
  }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

async function restSign(body: object, fw: Fw) {
  const sent: any[] = []
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: false, currentSeedEthAddress: KEY.address,
    getDeviceState: () => ({ state: 'ready', firmwareVersion: fw, capabilities: [], deviceId: 'rest-eth-fee-test' }),
    getCachedFeaturesSnapshot: () => undefined,
    wallet: {
      getFeatures: async () => ({
        majorVersion: 7, minorVersion: Number(fw.split('.')[1]), patchVersion: Number(fw.split('.')[2]),
        policiesList: [{ policyName: 'AdvancedMode', enabled: true }],
      }),
      ethSignTx: async (m: any) => { sent.push(structuredClone(m)); return deviceSign(m, fw) },
    },
  })
  const auth: any = { requireAuth: () => ({ name: 'dapp', url: 'https://dapp.example' }), extractBearerToken: () => 'test', validate: () => true, getAccount: () => ({ addressNList: PATH }) }
  const server = startRestApi(engine, auth, 0, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    onSigningRequest: async () => ({ approved: true }) as any,
    onSigningDismissed: () => {},
  } as any, '127.0.0.1')
  try {
    const post = (path: string, b: unknown) => originalFetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(b),
    })
    await post('/system/info/get-features', {})
    const res = await post('/eth/sign-transaction', { addressNList: PATH, ...body })
    return { status: res.status, body: await res.json() as any, sent }
  } finally {
    server.stop(true)
  }
}

const signer = (serialized: string) => utils.parseTransaction(serialized).from

test("the fake device hashes as the emulators did for A1 with Desktop's old gasPrice '0x0'", () => {
  const old = { to: A1.to, value: '0x0', data: A1.data, nonce: '0x7', gasLimit: '0xea60', chainId: 1, gasPrice: '0x0' }
  // deviceSignedHash recorded by kkemu-7.14.2 (0x00 byte, wrong signer) and kkemu-7.16.0 (canonical).
  expect(deviceHash(old, '7.14.2')).toBe('0xfa450c6ec57bbaf0ce2764e6fbdf8443140b26c24e031a00f5658f5b68c238d9')
  expect(deviceHash(old, '7.16.0')).toBe('0x05d58a7ebec7a9864d9762c30fd7ffddb30aca954852fc9ca00326df8974266b')
  expect(signer(deviceSign(old, '7.14.2').serialized)).not.toBe(KEY.address)
})

describe('REST /eth/sign-transaction with no fee in the request', () => {
  for (const fw of ['7.14.2', '7.16.0'] as Fw[]) {
    test(`${fw}: A1 (Ethereum) signs Pioneer's gas price and recovers to the signer`, async () => {
      const r = await restSign(A1, fw)
      expect(r.status).toBe(200)
      expect(gasPriceAsked).toEqual(['eip155:1'])
      expect(r.sent).toHaveLength(1)
      expect(r.sent[0].gasPrice).toBe(`0x${(12_500_000_000).toString(16)}`)
      expect(signer(r.body.serialized)).toBe(KEY.address)
      expect(utils.parseTransaction(r.body.serialized).gasPrice!.toString()).toBe('12500000000')
    }, 30_000)

    test(`${fw}: A5 (Base) asks Pioneer for Base and recovers to the signer`, async () => {
      const r = await restSign(A5, fw)
      expect(r.status).toBe(200)
      expect(gasPriceAsked).toEqual(['eip155:8453'])
      expect(signer(r.body.serialized)).toBe(KEY.address)
    }, 30_000)
  }

  test('Pioneer has no gas price: a clear error, nothing reaches the device', async () => {
    gasPriceAnswer = () => { throw new Error('socket hang up') }
    const r = await restSign(A1, '7.14.2')
    expect(r.status).toBe(502)
    expect(JSON.stringify(r.body)).toContain('gas price for chain 1 is unavailable')
    expect(r.sent).toHaveLength(0)
  }, 30_000)

  test('Pioneer reports a zero gas price: refused, never signed as a zero fee', async () => {
    gasPriceAnswer = () => ({ data: { average: 0 } })
    const r = await restSign(A1, '7.14.2')
    expect(r.status).toBe(502)
    expect(r.sent).toHaveLength(0)
  }, 30_000)
})

describe('REST /eth/sign-transaction sends canonical integers (7.14.2 hashes them as given)', () => {
  test("a caller's zero gasPrice and padded gas limit are sent minimal, and recover to the signer", async () => {
    const r = await restSign({ ...A1, gasPrice: '0x0', gas: '0x00ea60' }, '7.14.2')
    expect(r.status).toBe(200)
    expect(gasPriceAsked).toEqual([])
    expect(r.sent[0]).toMatchObject({ gasPrice: '0x', gasLimit: '0xea60' })
    expect(signer(r.body.serialized)).toBe(KEY.address)
  }, 30_000)

  test("a caller's gas price is signed as given", async () => {
    const r = await restSign({ ...A1, gasPrice: '0x3b9aca00' }, '7.14.2')
    expect(r.status).toBe(200)
    expect(gasPriceAsked).toEqual([])
    expect(r.sent[0].gasPrice).toBe('0x3b9aca00')
    expect(signer(r.body.serialized)).toBe(KEY.address)
  }, 30_000)
})
