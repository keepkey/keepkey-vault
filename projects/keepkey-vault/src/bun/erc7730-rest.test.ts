/**
 * REST /eth/sign-transaction when the device refuses the ERC-7730 definition
 * the approval card was built on: the user is asked again with the card for
 * the blind call it now is, whatever AdvancedMode, and the response and the
 * coverage record say what was signed. The ClearSign service is stubbed
 * (fetch); the definition is a real registry program signed under a TEST root.
 * The database is a fresh file in a temp dir.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { utils } from 'ethers'
import fixtures from './erc7730-resolver.fixtures.json'
import { ERC7730_FIXTURE_ROOT_PUBLIC_KEY, trustTestRoot } from '../../__tests__/support/clearsign-test-root'

// engine-controller's USB adapter is not loadable outside the app bundle; the
// REST server only needs the engine object this test passes in.
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-erc7730-rest-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('./db')
const { forgetRefusedErc7730Definitions } = await import('./erc7730-resolver')
const { startRestApi } = await import('./rest-api')

const { tx, definition } = fixtures.plain
const FROM = '0x1111111111111111111111111111111111111111'
const BODY = {
  addressNList: [0x8000002c, 0x8000003c, 0x80000000, 0, 0], from: FROM, to: tx.to, data: tx.data, value: tx.value,
  chainId: tx.chainId, nonce: '0x0', gas: '0x30000', gasPrice: '0x1',
}
const failure = (message: string) => ({ message_type: 'FAILURE', message_enum: 3, message: { code: 9, message } })

const originalFetch = globalThis.fetch
beforeAll(() => {
  db.initDb()
  // Simulation goes to a closed local port, not Pioneer.
  db.setSetting('evm_simulation_rpc_urls', JSON.stringify({ [String(tx.chainId)]: 'http://127.0.0.1:9/' }))
})
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
// The replay fixtures are signed under their TEST root: trusted for this file.
let restoreRoot = () => {}
beforeAll(() => { restoreRoot = trustTestRoot(ERC7730_FIXTURE_ROOT_PUBLIC_KEY) })
afterAll(() => restoreRoot())
beforeEach(() => {
  forgetRefusedErc7730Definitions()
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url)
    if (u.startsWith('http://127.0.0.1:')) return originalFetch(url, init)
    if (u.includes('/v1/erc7730/definition')) return Response.json(definition)
    return Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
  }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

const latestObservation = () => db.getDb()!.query(
  `SELECT protection_level, definition_source, outcome, shape_key FROM clearsign_observations ORDER BY created_at DESC LIMIT 1`,
).get() as { protection_level: string; definition_source: string; outcome: string; shape_key: string }

// What the history dialog will show for this txid (signed-tx-review.ts); '0xf8' is the fake device's serialized tx.
const latestReview = () => (db.getDb()!.query(`SELECT review_json FROM signed_tx_review ORDER BY rowid DESC LIMIT 1`).get() as { review_json: string } | null)
const reviewOfLastSign = () => db.getSignedTxReview(`eip155:${tx.chainId}`, utils.keccak256('0xf8'), 'erc7730-rest-test', `erc7730-rest-test:${FROM}`)

async function restSign(opts: { advancedMode?: boolean; declineSecondCard?: boolean; accept?: boolean; passphrase?: boolean }) {
  const sent: any[] = []
  const cards: any[] = []
  let atDevice: ReturnType<typeof latestObservation> | undefined
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: opts.passphrase === true, currentSeedEthAddress: FROM,
    getDeviceState: () => ({ state: 'ready', firmwareVersion: '7.16.0', capabilities: [1, 4], deviceId: 'erc7730-rest-test' }),
    getCachedFeaturesSnapshot: () => undefined,
    wallet: {
      getFeatures: async () => ({
        majorVersion: 7, minorVersion: 16, patchVersion: 0,
        policiesList: [{ policyName: 'AdvancedMode', enabled: opts.advancedMode === true }],
      }),
      ethSignTx: async (m: any) => {
        sent.push(structuredClone(m))
        atDevice ??= latestObservation()
        if (m.erc7730 && !opts.accept) throw failure('Value too long to clear-sign')
        return { v: 37, r: '0x01', s: '0x02', serialized: '0xf8' }
      },
    },
  })
  const auth: any = { requireAuth: () => ({ name: 'dapp', url: 'https://dapp.example' }), extractBearerToken: () => 'test', validate: () => true, getAccount: () => undefined }
  const server = startRestApi(engine, auth, 0, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    onSigningRequest: async (info: any) => {
      cards.push(structuredClone(info))
      return { approved: !(opts.declineSecondCard && cards.length === 2) } as any
    },
    onSigningDismissed: () => {},
  } as any)
  try {
    const post = (path: string, body: unknown) => originalFetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body),
    })
    // A known AdvancedMode state comes from a fresh features read.
    if (opts.advancedMode !== undefined) await post('/system/info/get-features', {})
    const res = await post('/eth/sign-transaction', BODY)
    return { status: res.status, body: await res.json() as any, sent, cards, observation: latestObservation(), atDevice: atDevice! }
  } finally {
    server.stop(true)
  }
}

describe('REST: the device refuses the ERC-7730 definition', () => {
  for (const advancedMode of [true, false, undefined]) {
    test(`AdvancedMode ${advancedMode ?? 'unknown'}: the blind card again, then the call without the definition`, async () => {
      const r = await restSign({ advancedMode })
      expect(r.sent.map((m) => Boolean(m.erc7730))).toEqual([true, false])
      expect(r.cards.length).toBe(2)
      expect(r.cards[0].erc7730).toBeDefined()
      expect(r.cards[0].clearSignReport.protectionLevel).toBe('P4')
      expect(r.cards[1].erc7730).toBeUndefined()
      expect(r.cards[1].needsBlindSigning).toBe(true)
      expect(r.cards[1].advancedModeEnabled).toBe(advancedMode)
      // The response reports what was signed: not the approved P4 description.
      expect(r.status).toBe(200)
      expect(r.body.clearSignReport.protectionLevel).not.toBe('P4')
      expect(r.body.clearSignReport.descriptor.source).toBe('none')
      // And so does the coverage record.
      expect(r.observation).toMatchObject({ definition_source: 'none', outcome: 'signed' })
      expect(r.observation.protection_level).not.toBe('P4')
      // History keeps the card for the blind call it became.
      expect(reviewOfLastSign()?.signedHow).toBe('blind')
    }, 30_000)
  }

  test('declining the second card: 403, nothing more signed, recorded as rejected', async () => {
    const r = await restSign({ advancedMode: true, declineSecondCard: true })
    expect(r.status).toBe(403)
    expect(r.sent.length).toBe(1)
    expect(r.observation.outcome).toBe('rejected')
  }, 30_000)

  test('the observation reaches P4 only when the device accepts the definition; until then its shape is queued for audit', async () => {
    const accepted = await restSign({ advancedMode: false, accept: true })
    expect(accepted.cards.length).toBe(1)
    expect(accepted.atDevice).toMatchObject({ definition_source: 'erc7730' })
    expect(accepted.atDevice.protection_level).not.toBe('P4')
    const job = db.getDb()!.query(`SELECT status, last_protection_level FROM clearsign_audit_jobs WHERE shape_key = ?`)
      .get(accepted.atDevice.shape_key) as { status: string; last_protection_level: string }
    expect(job.status).toBe('covered')
    expect(job.last_protection_level).toBe('P4')
    expect(accepted.observation).toMatchObject({ protection_level: 'P4', definition_source: 'erc7730', outcome: 'signed' })
    expect(reviewOfLastSign()?.signedHow).toBe('erc7730')
  }, 30_000)

  test('a passphrase wallet keeps no history record', async () => {
    db.getDb()!.run('DELETE FROM signed_tx_review')
    const r = await restSign({ advancedMode: false, accept: true, passphrase: true })
    expect(r.status).toBe(200)
    expect(latestReview()).toBeNull()
  }, 30_000)
})
