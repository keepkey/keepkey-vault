/**
 * REST and WalletConnect typed-data signing with production Permit2 and
 * test-root Safe definitions. The service is stubbed and the database is a
 * fresh file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trustTestRoot } from '../../__tests__/support/clearsign-test-root'
import fixture from './erc7730-typed-data.fixtures.json'
import safeFixture from './erc7730-safe.fixtures.json'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-erc7730-typed-rest-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('./db')
const { forgetRefusedErc7730Definitions } = await import('./erc7730-resolver')
const { startRestApi } = await import('./rest-api')

const FROM = '0x1111111111111111111111111111111111111111'
const PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
const originalFetch = globalThis.fetch
let lookups: string[] = []
let useSafeCatalog = false
let restoreRoot: (() => void) | undefined

beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  forgetRefusedErc7730Definitions()
  lookups = []
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url)
    if (u.startsWith('http://127.0.0.1:')) return originalFetch(url, init)
    if (u.includes('/v1/erc7730/definition')) {
      lookups.push(u)
      if (!useSafeCatalog) return Response.json(fixture.definition)
      const q = new URL(u).searchParams
      const definition = safeFixture.definitions.find(d => d.chainId === Number(q.get('chainId'))
        && d.contractAddress === q.get('contract') && d.selectorOrTypeHash === (q.get('typeHash') ?? q.get('selector')))
      return definition ? Response.json(definition) : new Response(null, { status: 404 })
    }
    return Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  restoreRoot?.()
  restoreRoot = undefined
  useSafeCatalog = false
})

function safeCatalog() {
  useSafeCatalog = true
  restoreRoot = trustTestRoot(safeFixture.testRootPubkey)
  return safeFixture.typedData
}

type SigningOptions = {
  typedData?: any
  refuse?: string
  onApprove?: (cardNumber: number) => boolean | void
}
const REFUSAL = 'ERC-7730 domain constraint does not match'

function expectFallbackCards(cards: any[]) {
  expect(cards).toHaveLength(2)
  expect(cards[0].clearSignReport.descriptor.source).toBe('erc7730')
  expect(cards[1].id).not.toBe(cards[0].id)
  expect(cards[1].erc7730).toBeUndefined()
  expect(cards[1].erc7730Description).toBeUndefined()
  expect(cards[1].needsBlindSigning).toBe(false)
  expect(cards[1].requiresAdvancedMode).toBe(false)
  expect(cards[1].clearSignReport.descriptor.authenticated).toBe(false)
  expect(cards[1].clearSignReport.limitations).toContainEqual(expect.objectContaining({
    code: 'ERC7730_DEFINITION_REFUSED', message: expect.stringContaining('raw hex'),
  }))
}

/** The clearsign observation this request recorded (newest). */
function lastObservation(): { definition_source: string; protection_level: string; outcome: string } {
  return db.getDb()!.query(`SELECT definition_source, protection_level, outcome FROM clearsign_observations ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as any
}

async function restSignTyped(firmwareVersion: string, opts: SigningOptions = {}) {
  const sent: any[] = []
  const cards: any[] = []
  const dismissed: string[] = []
  const [major, minor, patch] = firmwareVersion.split('.').map(Number)
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: false, currentSeedEthAddress: FROM,
    getDeviceState: () => ({ state: 'ready', firmwareVersion, capabilities: [1, 4, 28], deviceId: 'erc7730-typed-rest-test' }),
    getCachedFeaturesSnapshot: () => undefined,
    wallet: {
      getFeatures: async () => ({ majorVersion: major, minorVersion: minor, patchVersion: patch, policiesList: [] }),
      ethSignTypedData: async (m: any) => {
        sent.push(JSON.parse(JSON.stringify(m)))
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
    onSigningRequest: async (info: any) => {
      cards.push({ ...info, lookupsBefore: lookups.length })
      return { approved: opts.onApprove?.(cards.length) !== false }
    },
    onSigningDismissed: (id: string) => { dismissed.push(id) },
  } as any, '127.0.0.1')
  try {
    const res = await originalFetch(`http://127.0.0.1:${server.port}/eth/sign-typed-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ address: FROM, typedData: opts.typedData ?? fixture.typedData }),
    })
    return { status: res.status, body: await res.json() as any, sent, cards, dismissed }
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
    expect(r.cards[0].erc7730).toBeUndefined()
    expect(r.cards[0].clearSignReport.descriptor.source).not.toBe('erc7730')
  })

  test('7.17.0: the card and report describe the definition, fetched before approval', async () => {
    const r = await restSignTyped('7.17.0')
    expect(r.status).toBe(200)
    const card = r.cards[0]
    expect(card.lookupsBefore).toBe(1)
    expect(card.erc7730.primaryDefinitionId).toBe(fixture.definition.definitionId)
    expect(card.erc7730Description.signedBy).toBe('KeepKey ClearSign')
    expect(card.erc7730Description.intent).toBe('Authorize token transfer')
    expect(card.erc7730Description.fields.map((f: any) => f.label)).toEqual(['Spender', 'Amount', 'Deadline'])
    expect(card.erc7730Description.fields[0].value).toBe('0x6A57A0579E91A5B7ce9c2d08b93E1A9b995f974f')
    expect(card.clearSignReport.protectionLevel).toBe('P4')
    expect(card.clearSignReport.descriptor).toMatchObject({ source: 'erc7730', format: 'ERC7730', authenticated: true, signer: 'KeepKey ClearSign' })
  })

  test('7.17.0: exactly the approved definition is sent, even if the service answers differently after approval', async () => {
    const r = await restSignTyped('7.17.0', {
      onApprove: () => { globalThis.fetch = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch },
    })
    expect(r.status).toBe(200)
    expect(lookups).toHaveLength(1)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].erc7730).toEqual(r.cards[0].erc7730)
  })

  test('7.17.0: the observation is recorded as ERC-7730 and authenticated once the device signs', async () => {
    await restSignTyped('7.17.0')
    expect(lastObservation()).toMatchObject({ definition_source: 'erc7730', protection_level: 'P4', outcome: 'signed' })
  })

  test('7.17.0, refused: the observation is not left as ERC-7730', async () => {
    await restSignTyped('7.17.0', { refuse: 'ERC-7730 domain constraint does not match' })
    expect(lastObservation()).toMatchObject({ definition_source: 'none', outcome: 'signed' })
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

  for (const approve of [true, false]) {
    test(`SafeTx refusal sends raw calldata only if the user approves again (${approve})`, async () => {
      const r = await restSignTyped('7.17.0', {
        typedData: safeCatalog(), refuse: REFUSAL, onApprove: card => card === 1 || approve,
      })
      expect(r.status).toBe(approve ? 200 : 403)
      expectFallbackCards(r.cards)
      expect(r.dismissed).toEqual(r.cards.map(card => card.id))
      expect(r.sent.map(m => !!m.erc7730)).toEqual(approve ? [true, false] : [true])
      expect(lastObservation()).toMatchObject({ definition_source: 'none', outcome: approve ? 'signed' : 'rejected' })
    })
  }

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

describe('WalletConnect eth_signTypedData and ERC-7730', () => {
  async function wcSignTyped(firmwareVersion: string, opts: SigningOptions = {}) {
    const { WalletConnectManager } = await import('./walletconnect')
    const cap = { sent: [] as any[], cards: [] as any[], dismissed: [] as string[], authenticated: [] as string[], refused: [] as string[], finalized: [] as string[] }
    const manager: any = new WalletConnectManager({
      getEvmAddressInfo: () => ({ address: FROM, addressIndex: 0 }),
      ensureEvmAddressInfo: async () => null,
      ethSignTypedData: async (params: any, erc7730: any) => {
        cap.sent.push({ ...structuredClone(params), erc7730 })
        if (erc7730 && opts.refuse) throw { message_type: 'FAILURE', message_enum: 3, message: { code: 99, message: opts.refuse } }
        return { address: FROM, signature: `0x${'11'.repeat(65)}` }
      },
      getFirmwareVersion: () => firmwareVersion,
      getDeviceCapabilities: () => [1, 4, 28],
      recordClearSignObservation: () => 'obs',
      authenticateClearSignObservation: (_id: string, source: string) => { cap.authenticated.push(source) },
      finalizeClearSignObservation: (_id: string, outcome: string) => { cap.finalized.push(outcome) },
      refuseClearSignObservationDefinition: (id: string) => { cap.refused.push(id) },
      requestSigningApproval: async (card: any) => {
        cap.cards.push({ ...structuredClone(card), lookupsBefore: lookups.length })
        return opts.onApprove?.(cap.cards.length) !== false
      },
      dismissSigning: (id: string) => { cap.dismissed.push(id) },
      log: () => {},
    } as any)
    try {
      const signature = await manager.signTypedData(opts.typedData ?? fixture.typedData, PATH, 'test-dapp', 8453)
      return { cap, signature }
    } catch (error) {
      return { cap, error }
    }
  }

  test('7.17.0: the card describes the definition and exactly that one is sent', async () => {
    const { cap } = await wcSignTyped('7.17.0', {
      onApprove: () => { globalThis.fetch = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch },
    })
    expect(cap.cards[0].lookupsBefore).toBe(1)
    expect(cap.cards[0].erc7730Description.intent).toBe('Authorize token transfer')
    expect(cap.cards[0].clearSignReport.descriptor).toMatchObject({ source: 'erc7730', format: 'ERC7730', signer: 'KeepKey ClearSign' })
    expect(lookups).toHaveLength(1)
    expect(cap.sent).toHaveLength(1)
    expect(cap.sent[0].erc7730).toEqual(cap.cards[0].erc7730)
    expect(cap.authenticated).toEqual(['erc7730'])
  })

  test('7.17.0, refused: signed again without it, and not recorded as ERC-7730', async () => {
    const { cap } = await wcSignTyped('7.17.0', { refuse: 'ERC-7730 domain constraint does not match' })
    expect(cap.sent.map((m) => Boolean(m.erc7730))).toEqual([true, false])
    expect(cap.refused).toEqual(['obs'])
    expect(cap.authenticated).toEqual([])
    expect(cap.finalized).toEqual(['signed'])
  })

  for (const approve of [true, false]) {
    test(`SafeTx refusal sends raw calldata only if the user approves again (${approve})`, async () => {
      const { cap, signature, error } = await wcSignTyped('7.17.0', {
        typedData: safeCatalog(), refuse: REFUSAL, onApprove: card => card === 1 || approve,
      })
      expectFallbackCards(cap.cards)
      expect(cap.dismissed).toEqual(cap.cards.map(card => card.id))
      expect(cap.sent.map(m => !!m.erc7730)).toEqual(approve ? [true, false] : [true])
      expect(cap.finalized).toEqual([approve ? 'signed' : 'rejected'])
      if (approve) expect(signature).toBeDefined()
      else expect(error).toMatchObject({ message: 'User declined signing without the ClearSign description' })
    })
  }

  test('7.16.0: nothing is looked up, shown or sent', async () => {
    const { cap } = await wcSignTyped('7.16.0')
    expect(lookups).toEqual([])
    expect(cap.cards[0].erc7730).toBeUndefined()
    expect(cap.sent[0].erc7730).toBeUndefined()
  })
})
