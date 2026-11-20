/**
 * POST /hive/sign-operations with a caller-supplied header, over real HTTP routing.
 *
 * A wallet forwarding a dApp's Hive transaction (Skate Wallet) sends the dApp's
 * own TaPoS header and byte-compares the returned serialized_tx with its own
 * serialization before broadcast. So:
 *   - a full header is signed exactly as sent, with no Pioneer fetch;
 *   - a partial, out-of-range, expired or too-far-ahead header is refused, and
 *     refused before the approval window when it is already doomed;
 *   - a header that expires while the user approves is refused, not refreshed;
 *   - without a header, the Pioneer path is unchanged;
 *   - the signing gate, the bearer check and the operation whitelist are unchanged.
 *
 * The wallet is in memory: nothing reaches a device and nothing is broadcast.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, setSystemTime, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-hive-sign-ops-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
const { HttpError } = await import('../src/bun/auth')
const { startRestApi } = await import('../src/bun/rest-api')
const { serializeHiveOpsTx, hiveTimeIso, HIVE_MAINNET_CHAIN_ID } = await import('../src/bun/txbuilder/hive-ops')

const H = 0x80000000
const POSTING = [H + 48, H + 13, H + 4, H, H]
const ACTIVE_ACCOUNT_2 = [H + 48, H + 13, H + 1, H + 2, H]
const VOTE = ['vote', { voter: 'alice', author: 'bob', permlink: 'p', weight: 10000 }]
const TESTNET = '18dcf0a285365fc58b71f18b3d3fec954aa0c141c44e4e5cb4cf777b9eab274e'
const PIONEER = { refBlockNum: 777, refBlockPrefix: 123456789, chainId: HIVE_MAINNET_CHAIN_ID }

const nowUnix = () => Math.floor(Date.now() / 1000)
const header = (secondsAhead = 60) => ({ ref_block_num: 4660, ref_block_prefix: 0xdeadbeef, expiration: hiveTimeIso(nowUnix() + secondsAhead) })

let pioneer: ReturnType<typeof Bun.serve>
let pioneerHits = 0
beforeAll(() => {
  db.initDb()
  db.setSetting('hive_enabled', '1')
  pioneer = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(req) {
      if (new URL(req.url).pathname !== '/api/v1/hive/tx-params') return new Response('not found', { status: 404 })
      pioneerHits++
      return Response.json({ success: true, ...PIONEER, expirationUnix: nowUnix() + 60 })
    },
  })
})
afterEach(() => { setSystemTime() })
afterAll(() => { pioneer.stop(true); db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

function fixture({ onApprove }: { onApprove?: () => void } = {}) {
  pioneerHits = 0
  const state = { approvals: 0, signed: [] as { addressNList: number[]; chainId: string; serializedTx: Uint8Array }[] }
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: false, isLocked: false,
    getDeviceState: () => ({ state: 'ready', firmwareVersion: '7.17.0', deviceId: 'hive-exact-header' }),
    getCachedFeaturesSnapshot: () => undefined,
    wallet: {
      hiveSignOperations: async (msg: any) => { state.signed.push(msg); return { signature: new Uint8Array(65).fill(0x1f) } },
    },
  })
  const auth: any = {
    requireAuth: (req: Request) => {
      if (!req.headers.get('authorization')) throw new HttpError(401, 'Unauthorized')
      return { name: 'Skate Wallet test', url: 'https://wallet.example.invalid' }
    },
    extractBearerToken: (req: Request) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
    validate: () => true,
    getAccount: () => undefined,
  }
  const server = startRestApi(engine, auth, 0, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    getPioneerApiBase: () => `http://127.0.0.1:${pioneer.port}`,
    onSigningRequest: async () => { state.approvals++; onApprove?.(); return { approved: true } },
    onSigningDismissed: () => {},
  } as any, '127.0.0.1')
  async function post(body: unknown, bearer = true) {
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/hive/sign-operations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer test' } : {}) },
        body: JSON.stringify(body),
      })
      return { status: res.status, data: await res.json() as any }
    } finally { server.stop(true) }
  }
  return { state, post }
}

describe('exact caller header', () => {
  test('is signed exactly as sent, without a Pioneer fetch, and the signed bytes are echoed', async () => {
    const f = fixture()
    const sent = header()
    const { status, data } = await f.post({ operations: [VOTE], ...sent })
    expect(status).toBe(200)
    expect(pioneerHits).toBe(0)
    expect(f.state.approvals).toBe(1)
    expect(f.state.signed).toHaveLength(1)
    const device = f.state.signed[0]
    // What the device got is what the response says it got, byte for byte…
    expect(Buffer.from(device.serializedTx).toString('hex')).toBe(data.serialized_tx)
    // …and it matches the caller's own serialization of the caller's header.
    const own = serializeHiveOpsTx({
      refBlockNum: sent.ref_block_num, refBlockPrefix: sent.ref_block_prefix,
      expirationUnix: Date.parse(sent.expiration + 'Z') / 1000, operations: [VOTE as any],
    })
    expect(data.serialized_tx).toBe(own.serializedTx.toString('hex'))
    expect(device.chainId).toBe(HIVE_MAINNET_CHAIN_ID)
    expect(device.addressNList).toEqual(POSTING)
    expect(data).toMatchObject({
      ref_block_num: 4660, ref_block_prefix: 0xdeadbeef, expiration: sent.expiration,
      chain_id: HIVE_MAINNET_CHAIN_ID, header_source: 'caller', address_n: POSTING, role: 'posting',
      signature: '1f'.repeat(65), operations: [VOTE],
    })
  })

  test('unix-seconds expiration, a caller chain id and a pinned path are used as given', async () => {
    const f = fixture()
    const expiration = nowUnix() + 120
    const { status, data } = await f.post({
      operations: [['transfer_to_vesting', { from: 'alice', to: 'alice', amount: '1.000 HIVE' }]],
      ref_block_num: 0xffff, ref_block_prefix: 0xffffffff, expiration, chain_id: TESTNET.toUpperCase(), address_n: ACTIVE_ACCOUNT_2,
    })
    expect(status).toBe(200)
    expect(pioneerHits).toBe(0)
    const tx = Buffer.from(f.state.signed[0].serializedTx)
    expect([tx.readUInt16LE(0), tx.readUInt32LE(2), tx.readUInt32LE(6)]).toEqual([0xffff, 0xffffffff, expiration])
    expect(f.state.signed[0].chainId).toBe(TESTNET)
    expect(data).toMatchObject({ expiration: hiveTimeIso(expiration), chain_id: TESTNET, address_n: ACTIVE_ACCOUNT_2, role: 'active' })
  })

  test.each([
    ['a partial header', { ref_block_num: 1, ref_block_prefix: 2 }, /Partial Hive header.*missing expiration/],
    ['a chain id without a header', { chain_id: TESTNET }, /chain_id is accepted only with an exact header/],
    ['an expired header', { ...header(-1) }, /Hive header expired at/],
    ['a header more than an hour ahead', { ...header(3700) }, /a node accepts at most 3600s/],
    ['an out-of-range ref_block_num', { ...header(), ref_block_num: 0x10000 }, /ref_block_num must be an integer 0–65535/],
    ['an out-of-range ref_block_prefix', { ...header(), ref_block_prefix: -1 }, /ref_block_prefix must be an integer/],
    ['a time with a zone offset', { ...header(), expiration: '2026-11-20T12:00:00+02:00' }, /not a Hive time/],
  ])('%s is refused before the approval window, and nothing is signed', async (_label, fields, message) => {
    const f = fixture()
    const { status, data } = await f.post({ operations: [VOTE], ...fields })
    expect(status).toBe(400)
    expect(String(data.error)).toMatch(message)
    expect(f.state.approvals).toBe(0)
    expect(f.state.signed).toHaveLength(0)
    expect(pioneerHits).toBe(0)
  })

  test('a header that expires while the user approves is refused, not refreshed', async () => {
    const sent = header(30)
    const f = fixture({ onApprove: () => setSystemTime(new Date(Date.now() + 31_000)) })
    const { status, data } = await f.post({ operations: [VOTE], ...sent })
    expect(status).toBe(400)
    expect(String(data.error)).toMatch(new RegExp(`Hive header expired at ${sent.expiration}`))
    expect(f.state.approvals).toBe(1)
    expect(f.state.signed).toHaveLength(0)
    expect(pioneerHits).toBe(0)
  })
})

describe('unchanged behavior', () => {
  test('without a header the Vault fetches it from Pioneer and signs that', async () => {
    const f = fixture()
    const { status, data } = await f.post({ operations: [VOTE] })
    expect(status).toBe(200)
    expect(pioneerHits).toBe(1)
    const tx = Buffer.from(f.state.signed[0].serializedTx)
    expect([tx.readUInt16LE(0), tx.readUInt32LE(2)]).toEqual([PIONEER.refBlockNum, PIONEER.refBlockPrefix])
    expect(data).toMatchObject({
      ref_block_num: PIONEER.refBlockNum, ref_block_prefix: PIONEER.refBlockPrefix,
      header_source: 'pioneer', serialized_tx: tx.toString('hex'), role: 'posting',
    })
  })

  test('an operation outside the clear-sign table is still refused with an exact header', async () => {
    const f = fixture()
    const { status, data } = await f.post({ operations: [['transfer', { from: 'alice', to: 'bob', amount: '1.000 HIVE', memo: '' }]], ...header() })
    expect(status).toBe(400)
    expect(String(data.error)).toMatch(/Unsupported Hive operation "transfer"/)
    expect(f.state.signed).toHaveLength(0)
  })

  test('mixed-tier operations are still refused with an exact header', async () => {
    const f = fixture()
    const { status, data } = await f.post({
      operations: [VOTE, ['transfer_to_vesting', { from: 'alice', to: 'alice', amount: '1.000 HIVE' }]], ...header(),
    })
    expect(status).toBe(400)
    expect(String(data.error)).toMatch(/Cannot mix posting-tier and active-tier/)
    expect(f.state.signed).toHaveLength(0)
  })

  test('an empty probe still stops at the signing gate', async () => {
    const f = fixture()
    const { status, data } = await f.post({})
    expect(status).toBe(400)
    expect(String(data.error)).toMatch(/Missing signing payload|Empty or invalid signing payload/)
    expect(f.state.approvals).toBe(0)
  })

  test('a header-only body without operations still stops at the signing gate', async () => {
    const f = fixture()
    const { status, data } = await f.post({ ...header() })
    expect(status).toBe(400)
    expect(String(data.error)).toMatch(/Missing signing payload/)
    expect(f.state.approvals).toBe(0)
  })

  test('a bearer is still required, even for a malformed header', async () => {
    const f = fixture()
    expect((await f.post({ operations: [VOTE], ref_block_num: 1 }, false)).status).toBe(401)
    expect(f.state.approvals).toBe(0)
  })
})
