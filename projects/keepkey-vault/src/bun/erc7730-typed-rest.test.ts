/**
 * REST /eth/sign-typed-data with a real 0x Permit2 request: Desktop attaches
 * the ClearSign service's typed-data definition only for firmware 7.17.0+, and
 * signs again without it if the device refuses it. The service is stubbed
 * (fetch) with the production batch-4 envelope; the database is a fresh file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fixture from './erc7730-typed-data.fixtures.json'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-erc7730-typed-rest-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('./db')
const { forgetRefusedErc7730Definitions } = await import('./erc7730-resolver')
const { startRestApi } = await import('./rest-api')

const FROM = '0x1111111111111111111111111111111111111111'
const PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
const originalFetch = globalThis.fetch
let lookups: string[] = []

beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  forgetRefusedErc7730Definitions()
  lookups = []
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url)
    if (u.startsWith('http://127.0.0.1:')) return originalFetch(url, init)
    if (u.includes('/v1/erc7730/definition')) { lookups.push(u); return Response.json(fixture.definition) }
    return Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
  }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

async function restSignTyped(firmwareVersion: string, opts: { typedData?: any; refuse?: string } = {}) {
  const sent: any[] = []
  const [major, minor, patch] = firmwareVersion.split('.').map(Number)
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: false, currentSeedEthAddress: FROM,
    getDeviceState: () => ({ state: 'ready', firmwareVersion, capabilities: [1, 4], deviceId: 'erc7730-typed-rest-test' }),
    getCachedFeaturesSnapshot: () => undefined,
    wallet: {
      getFeatures: async () => ({ majorVersion: major, minorVersion: minor, patchVersion: patch, policiesList: [] }),
      ethSignTypedData: async (m: any) => {
        sent.push(structuredClone(m))
        if (m.erc7730 && opts.refuse) throw { message_type: 'FAILURE', message_enum: 3, message: { code: 99, message: opts.refuse } }
        return { address: FROM, signature: `0x${'11'.repeat(65)}` }
      },
    },
  })
  const auth: any = {
    requireAuth: () => ({ name: 'dapp', url: 'https://dapp.example' }), extractBearerToken: () => 'test', validate: () => true,
    getAccount: () => ({ addressNList: PATH }),
  }
  const server = startRestApi(engine, auth, 0, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    onSigningRequest: async () => ({ approved: true }) as any,
    onSigningDismissed: () => {},
  } as any)
  try {
    const res = await originalFetch(`http://127.0.0.1:${server.port}/eth/sign-typed-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ address: FROM, typedData: opts.typedData ?? fixture.typedData }),
    })
    return { status: res.status, body: await res.json() as any, sent }
  } finally {
    server.stop(true)
  }
}

describe('REST /eth/sign-typed-data and ERC-7730', () => {
  test('7.16.0: no definition is looked up or sent (typed data stays off)', async () => {
    const r = await restSignTyped('7.16.0')
    expect(r.status).toBe(200)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].erc7730).toBeUndefined()
    expect(lookups).toEqual([])
  })

  test('7.17.0: the service definition for this document rides with it', async () => {
    const r = await restSignTyped('7.17.0')
    expect(r.status).toBe(200)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].erc7730.primaryDefinitionId).toBe(fixture.definition.definitionId)
    expect(r.sent[0].erc7730.definitions[0].kind).toBe(2)
    expect(r.sent[0].typedData).toEqual(fixture.typedData)
    expect(lookups).toHaveLength(1)
    expect(lookups[0]).toContain('kind=eip712&chainId=8453')
  })

  test('7.17.0, the device refuses the definition: signed again without it', async () => {
    const r = await restSignTyped('7.17.0', { refuse: 'ERC-7730 domain constraint does not match' })
    expect(r.status).toBe(200)
    expect(r.sent.map((m) => !!m.erc7730)).toEqual([true, false])
  })

  test('7.17.0, PermitSingle: never a definition (the native Permit2 review stays)', async () => {
    const permitSingle = {
      types: {
        EIP712Domain: fixture.typedData.types.EIP712Domain,
        PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
        PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
      },
      domain: fixture.typedData.domain,
      primaryType: 'PermitSingle',
      message: {
        details: { token: '0x4200000000000000000000000000000000000006', amount: '100000000000000', expiration: '1738723608', nonce: '0' },
        spender: '0x6a57a0579e91a5b7ce9c2d08b93e1a9b995f974f', sigDeadline: '1738723608',
      },
    }
    const r = await restSignTyped('7.17.0', { typedData: permitSingle })
    expect(r.status).toBe(200)
    expect(r.sent[0].erc7730).toBeUndefined()
    expect(lookups).toEqual([])
  })
})
