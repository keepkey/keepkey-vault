import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClearSignProvider } from '../shared/types'
import {
  addClearSignProvider, configureClearSignProviders, ensureClearSignProviderTable, listClearSignProviders,
  providerFingerprint, providerFor, removeClearSignProvider, resolveProviderTxMetadata, seedClearSignProviderFromEnv,
} from './clearsign-providers'

// The 'Acme Labs' key from the 7.16.0 emulator run: the device showed
// "Trust 'Acme Labs' (656B0D303F6BBDBD) ... NOT verified by KeepKey".
const ACME = '0246bda74e01a6587ece226943fbff7a10a55cc6971ea2113b0fc6fc90550ba139'
const OTHER = `03${'22'.repeat(32)}`
const CONTRACT_A = '0x' + 'aa'.repeat(20)
const CONTRACT_B = '0x' + 'bb'.repeat(20)
const PAYLOAD = 'ab'.repeat(80)
const fp8 = (pub: string) => createHash('sha256').update(Uint8Array.from(Buffer.from(pub, 'hex'))).digest('hex').slice(0, 8)

/** A real local provider: answers /signer with `publicKeyHex` and /sign with a payload, counting every request. */
function startProvider(publicKeyHex: string, alias = 'Acme Labs') {
  const hits: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      hits.push(`${req.method} ${path}`)
      if (path === '/signer') return Response.json({ keyId: 2, alias, publicKeyHex, fingerprint: fp8(publicKeyHex) })
      if (path === '/sign') return Response.json({ keyId: 2, signedPayload: `0x${PAYLOAD}` })
      if (path === '/rpc') {
        const body: any = await req.json().catch(() => ({}))
        return Response.json({ jsonrpc: '2.0', id: body?.id ?? 1, error: { code: -32000, message: 'test node' } })
      }
      return Response.json({ error: 'not covered' }, { status: 404 })
    },
  })
  return { hits, server, url: `http://127.0.0.1:${server.port}` }
}

function memoryDb(): Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  ensureClearSignProviderTable(db)
  return db
}

const servers: Array<{ stop: (force?: boolean) => void }> = []
afterAll(() => { for (const s of servers) s.stop(true) })
afterEach(() => configureClearSignProviders(() => []))

const GATE_ON = { firmwareVersion: '7.16.0', advancedMode: true }
const tx = (to: string) => ({ chainId: 1, nonce: '0x1', gasLimit: '0x30000', gasPrice: '0x1', to, value: '0x0', data: '0xdeadbeef' })

describe('ClearSign provider list', () => {
  test('fingerprint matches what the 7.16 device shows', () => {
    expect(providerFingerprint(ACME)).toBe('656B0D303F6BBDBD')
  })

  test('add, list and remove round-trip', () => {
    const db = memoryDb()
    const added = addClearSignProvider(db, {
      name: 'Acme Labs', url: 'https://acme.example/clearsign/', publicKeyHex: `0x${ACME.toUpperCase()}`,
      contracts: [{ chainId: 1, address: CONTRACT_A.toUpperCase().replace('0X', '0x') }, { chainId: 1, address: CONTRACT_A }],
    })
    expect(added).toMatchObject({
      name: 'Acme Labs', url: 'https://acme.example/clearsign', publicKeyHex: ACME, fingerprint: '656B0D303F6BBDBD',
      contracts: [{ chainId: 1, address: CONTRACT_A }],
    })
    expect(listClearSignProviders(db)).toEqual([added])
    expect(() => addClearSignProvider(db, { name: 'Again', url: 'https://acme.example/clearsign', publicKeyHex: ACME }))
      .toThrow('already added')
    removeClearSignProvider(db, added.id)
    expect(listClearSignProviders(db)).toEqual([])
  })

  test('rejects a bad key, name, URL or contract', () => {
    const db = memoryDb()
    const ok = { name: 'Acme Labs', url: 'https://acme.example', publicKeyHex: ACME }
    expect(() => addClearSignProvider(db, { ...ok, publicKeyHex: `04${'11'.repeat(32)}` })).toThrow('33-byte compressed')
    expect(() => addClearSignProvider(db, { ...ok, publicKeyHex: ACME.slice(0, 64) })).toThrow('33-byte compressed')
    expect(() => addClearSignProvider(db, { ...ok, name: 'KeepKey "Official"' })).toThrow('Name must be')
    expect(() => addClearSignProvider(db, { ...ok, name: 'x'.repeat(32) })).toThrow('Name must be')
    expect(() => addClearSignProvider(db, { ...ok, url: 'http://acme.example' })).toThrow('https')
    expect(() => addClearSignProvider(db, { ...ok, url: 'not a url' })).toThrow('valid URL')
    expect(() => addClearSignProvider(db, { ...ok, contracts: [{ chainId: 0, address: CONTRACT_A }] })).toThrow('chain ID')
    expect(() => addClearSignProvider(db, { ...ok, contracts: [{ chainId: 1, address: '0x1234' }] })).toThrow('20-byte')
    expect(listClearSignProviders(db)).toEqual([])
    // Local development providers may use plain http.
    expect(addClearSignProvider(db, { ...ok, url: 'http://127.0.0.1:1647' }).url).toBe('http://127.0.0.1:1647')
  })

  test('routing picks the scoped provider, else the first unscoped one', () => {
    const p = (id: string, contracts: ClearSignProvider['contracts']): ClearSignProvider => ({
      id, name: id, url: `https://${id}.example`, publicKeyHex: ACME, fingerprint: '', contracts, createdAt: 0,
    })
    const providers = [p('any', []), p('scoped', [{ chainId: 1, address: CONTRACT_A }])]
    expect(providerFor(providers, 1, CONTRACT_A.toUpperCase().replace('0X', '0x'))?.id).toBe('scoped')
    expect(providerFor(providers, 10, CONTRACT_A)?.id).toBe('any')
    expect(providerFor(providers.slice(1), 1, CONTRACT_B)).toBeUndefined()
  })
})

describe('resolveProviderTxMetadata (shared by REST, RPC, swaps and WalletConnect)', () => {
  test('asks only the provider scoped to the contract and names it on the device', async () => {
    const a = startProvider(ACME); servers.push(a.server)
    const b = startProvider(OTHER, 'Other'); servers.push(b.server)
    const db = memoryDb()
    addClearSignProvider(db, { name: 'Acme Labs', url: a.url, publicKeyHex: ACME, contracts: [{ chainId: 1, address: CONTRACT_A }] })
    addClearSignProvider(db, { name: 'Other', url: b.url, publicKeyHex: OTHER, contracts: [{ chainId: 1, address: CONTRACT_B }] })

    const result = await resolveProviderTxMetadata(tx(CONTRACT_A), GATE_ON, listClearSignProviders(db))
    expect(result?.txMetadata).toEqual({ signedPayload: `0x${PAYLOAD}`, keyId: 2 })
    expect(result?.signer).toMatchObject({ keyId: 2, alias: 'Acme Labs', publicKeyHex: ACME })
    expect(result?.provider.fingerprint).toBe('656B0D303F6BBDBD')
    expect(a.hits.sort()).toEqual(['GET /signer', 'POST /sign'])
    expect(b.hits).toEqual([])

    // A contract no provider covers contacts nobody.
    expect(await resolveProviderTxMetadata(tx('0x' + 'cc'.repeat(20)), GATE_ON, listClearSignProviders(db))).toBeUndefined()
    expect(a.hits.length + b.hits.length).toBe(2)
  })

  test('contacts nobody without AdvancedMode, on old firmware, or when the call is already described', async () => {
    const a = startProvider(ACME); servers.push(a.server)
    const providers = [addClearSignProvider(memoryDb(), { name: 'Acme Labs', url: a.url, publicKeyHex: ACME })]
    expect(await resolveProviderTxMetadata(tx(CONTRACT_A), { firmwareVersion: '7.16.0', advancedMode: false }, providers)).toBeUndefined()
    expect(await resolveProviderTxMetadata(tx(CONTRACT_A), { firmwareVersion: '7.14.2', advancedMode: true }, providers)).toBeUndefined()
    expect(await resolveProviderTxMetadata({ ...tx(CONTRACT_A), txMetadata: { signedPayload: '0x00', keyId: 0x80 } }, GATE_ON, providers)).toBeUndefined()
    expect(await resolveProviderTxMetadata({ ...tx(CONTRACT_A), erc7730: { definitions: [] } }, GATE_ON, providers)).toBeUndefined()
    expect(a.hits).toEqual([])
  })

  test('refuses a provider URL that answers with a different key than the one added', async () => {
    const a = startProvider(OTHER); servers.push(a.server)
    const providers = [addClearSignProvider(memoryDb(), { name: 'Acme Labs', url: a.url, publicKeyHex: ACME })]
    await expect(resolveProviderTxMetadata(tx(CONTRACT_A), GATE_ON, providers)).rejects.toThrow('not the one you added (656B0D303F6BBDBD)')
  })

  test('reads the list registered by the database layer by default', async () => {
    const a = startProvider(ACME); servers.push(a.server)
    const db = memoryDb()
    addClearSignProvider(db, { name: 'Acme Labs', url: a.url, publicKeyHex: ACME })
    configureClearSignProviders(() => listClearSignProviders(db))
    expect((await resolveProviderTxMetadata(tx(CONTRACT_A), GATE_ON))?.signer.alias).toBe('Acme Labs')
  })
})

describe('CLEARSIGN_RUNTIME_URL is only a migration seed', () => {
  test('seeds the list once from /signer; removing the entry sticks', async () => {
    const a = startProvider(ACME, 'Acme <Labs>!'); servers.push(a.server)
    const db = memoryDb()
    const seeded = await seedClearSignProviderFromEnv(db, `${a.url}/`)
    expect(seeded).toMatchObject({ name: 'Acme Labs', url: a.url, publicKeyHex: ACME, contracts: [] })
    expect(await seedClearSignProviderFromEnv(db, a.url)).toBeUndefined()
    removeClearSignProvider(db, seeded!.id)
    expect(await seedClearSignProviderFromEnv(db, a.url)).toBeUndefined()
    expect(listClearSignProviders(db)).toEqual([])
    expect(a.hits).toEqual(['GET /signer'])
    expect(await seedClearSignProviderFromEnv(db, '')).toBeUndefined()
  })

  test('no signing path reads the env var or calls the provider resolver directly', () => {
    const dir = import.meta.dir
    for (const file of ['index.ts', 'rest-api.ts', 'swap.ts', 'walletconnect.ts', 'evm-runtime-metadata.ts']) {
      const source = readFileSync(join(dir, file), 'utf8')
      expect(source.includes('process.env.CLEARSIGN_RUNTIME_URL')).toBe(false)
      expect(/resolveRuntimeEvmMetadata\(/.test(source) && file !== 'evm-runtime-metadata.ts').toBe(false)
    }
    for (const file of ['index.ts', 'rest-api.ts', 'swap.ts', 'walletconnect.ts']) {
      expect(readFileSync(join(dir, file), 'utf8')).toContain('resolveProviderTxMetadata(')
    }
  })
})

describe('WalletConnect eth_sendTransaction uses the provider step', () => {
  const FROM = '0x1111111111111111111111111111111111111111'

  async function wcSign(advancedMode: boolean, rpcUrl: string) {
    const { WalletConnectManager } = await import('./walletconnect')
    const cap: { msg?: any; loaded: any[] } = { loaded: [] }
    const manager: any = new WalletConnectManager({
      getEvmAddressInfo: () => ({ address: FROM, addressIndex: 0 }),
      ensureEvmAddressInfo: async () => null,
      ethSignTx: async (msg: any) => { cap.msg = msg; throw new Error('test-stop') },
      getAdvancedModeEnabled: () => advancedMode,
      loadClearsignSigner: async (signer: any) => { cap.loaded.push(signer) },
      getFirmwareVersion: () => '7.16.0',
      getEvmSimulationEndpoint: () => rpcUrl,
      getSolanaRpcEndpoint: () => rpcUrl,
      recordClearSignObservation: () => undefined,
      authenticateClearSignObservation: () => {},
      finalizeClearSignObservation: () => {},
      requestSigningApproval: async () => true,
      dismissSigning: () => {},
      log: () => {},
    } as any)
    await expect(manager.signTransaction({
      from: FROM, to: CONTRACT_A, data: '0xdeadbeef' + '00'.repeat(31) + '01', value: '0x0',
      chainId: '0x1', nonce: '0x0', gas: '0x30000', gasPrice: '0x1',
    }, [0x8000002c, 0x8000003c, 0x80000000, 0, 0], 'test-dapp', 1, false)).rejects.toThrow('test-stop')
    return cap
  }

  test('with AdvancedMode on, the matching provider describes the final transaction', async () => {
    const p = startProvider(ACME); servers.push(p.server)
    const previous = process.env.CLEARSIGN_SERVICE_URL
    process.env.CLEARSIGN_SERVICE_URL = `${p.url}/certified`
    try {
      // Load walletconnect (and the db layer it pulls in, which registers its
      // own provider source) before registering this test's list.
      await import('./walletconnect')
      const db = memoryDb()
      addClearSignProvider(db, { name: 'Acme Labs', url: p.url, publicKeyHex: ACME, contracts: [{ chainId: 1, address: CONTRACT_A }] })
      configureClearSignProviders(() => listClearSignProviders(db))

      const on = await wcSign(true, `${p.url}/rpc`)
      expect(p.hits).toContain('GET /signer')
      expect(p.hits).toContain('POST /sign')
      expect(on.loaded.map(s => s.alias)).toEqual(['Acme Labs'])
      expect(on.msg.txMetadata).toEqual({ signedPayload: `0x${PAYLOAD}`, keyId: 2 })
      expect(on.msg.nonce).toBe('0x0')

      p.hits.length = 0
      const off = await wcSign(false, `${p.url}/rpc`)
      expect(p.hits.filter(h => h === 'GET /signer' || h === 'POST /sign')).toEqual([])
      expect(off.loaded).toEqual([])
      expect(off.msg.txMetadata).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.CLEARSIGN_SERVICE_URL
      else process.env.CLEARSIGN_SERVICE_URL = previous
    }
  })
})
