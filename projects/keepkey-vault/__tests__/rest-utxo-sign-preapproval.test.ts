/**
 * POST /utxo/sign-transaction is validated before the approval card opens.
 *
 * A request the handler would refuse (bad path, bad multisig cosigner suffix,
 * wrong shape) used to open the approval card first and return 400 only after
 * the user approved, which teaches users to approve without reading. Now:
 *   - an invalid request is 400 with the handler's own message, and the card never opens,
 *     even with BTC multisig on (a bad cosigner suffix, as in the QA test on a real KeepKey);
 *   - multisig while the feature is off keeps its 403 "enable it" message;
 *   - a locked wallet is not asked to unlock for an invalid request;
 *   - a valid request still opens the card exactly once;
 *   - an empty body still gets the gate's probe error (rest-sign-gating.test.ts relies on it).
 *
 * The wallet is in memory: nothing reaches a device. The card is rejected, so nothing is signed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-utxo-preapproval-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
const { HttpError } = await import('../src/bun/auth')
const { startRestApi } = await import('../src/bun/rest-api')
const S = await import('../src/bun/schemas')
const { validationErrorMessage } = await import('../src/bun/validate')
const { BTC_MULTISIG_SETTING, BTC_MULTISIG_DISABLED } = await import('../src/bun/btc-psbt/multisig-feature')

const H = 0x80000000
const BIP84 = [H + 84, H, H, 0, 0]
const output = { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '1000', addressType: 'spend' }
const input = (extra: Record<string, unknown> = {}) => ({ txid: 'a'.repeat(64), vout: 0, amount: '5000', scriptType: 'p2wpkh', addressNList: BIP84, ...extra })
const multisig = (suffix: number[]) => ({ m: 2, pubkeys: [{ xpub: 'xpub-a', addressNList: [0, 0] }, { xpub: 'xpub-b', addressNList: suffix }], signatures: ['', ''] })

beforeAll(() => { db.initDb() })
afterEach(() => { db.setSetting(BTC_MULTISIG_SETTING, '0') })
const multisigOn = () => db.setSetting(BTC_MULTISIG_SETTING, '1')
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

async function post(body: unknown, { locked = false } = {}) {
  const state = { approvals: 0, signed: 0 }
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: false, isLocked: locked,
    getDeviceState: () => ({ state: 'ready', firmwareVersion: '7.17.0', deviceId: 'utxo-preapproval' }),
    getCachedFeaturesSnapshot: () => undefined,
    wallet: { btcSignTx: async () => { state.signed++; return { serializedTx: '00', signatures: [] } } },
  })
  const auth: any = {
    requireAuth: (req: Request) => {
      if (!req.headers.get('authorization')) throw new HttpError(401, 'Unauthorized')
      return { name: 'UTXO pre-approval test', url: 'https://wallet.example.invalid' }
    },
    extractBearerToken: (req: Request) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
    validate: () => true,
    getAccount: () => undefined,
  }
  const server = startRestApi(engine, auth, 0, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    onSigningRequest: async () => { state.approvals++; return { approved: false } },
    onSigningDismissed: () => {},
  } as any, '127.0.0.1')
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/utxo/sign-transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: await res.json() as any, ...state }
  } finally { server.stop(true) }
}

describe('POST /utxo/sign-transaction before the approval card', () => {
  const hardenedSuffix = { coin: 'Bitcoin', inputs: [input({ scriptType: 'p2wsh', multisig: multisig([H, 0]) })], outputs: [output] }
  // Multisig cases run with BTC multisig on, as in the QA test on a real KeepKey.
  const invalid: [string, unknown, boolean?][] = [
    ['multisig on, a hardened cosigner suffix', hardenedSuffix, true],
    ['multisig on, a 9-level cosigner suffix', { coin: 'Bitcoin', inputs: [input({ scriptType: 'p2wsh', multisig: multisig([0, 0, 0, 0, 0, 0, 0, 0, 0]) })], outputs: [output] }, true],
    ['multisig on, a bad cosigner suffix on a change output', { coin: 'Bitcoin', inputs: [input()], outputs: [{ ...output, multisig: multisig([H]) }] }, true],
    ['an input path element of 2^32', { coin: 'Bitcoin', inputs: [input({ addressNList: [H + 84, H, H, 0, 2 ** 32] })], outputs: [output] }],
    ['no outputs', { coin: 'Bitcoin', inputs: [input()], outputs: [] }],
    ['inputs that are not a list', { coin: 'Bitcoin', inputs: 'all of them', outputs: [output] }],
  ]

  for (const [name, body, withMultisig] of invalid) {
    test(`${name}: 400 with the handler's message, and the card never opens`, async () => {
      if (withMultisig) multisigOn()
      const r = await post(body)
      expect(r.status).toBe(400)
      const parsed = S.UtxoSignTransactionRequest.safeParse(body)
      expect(parsed.success).toBe(false)
      expect(r.data.error).toBe(validationErrorMessage((parsed as any).error))
      expect(r.approvals).toBe(0)
      expect(r.signed).toBe(0)
    })
  }

  test('a valid request still opens the card once (rejected here, so nothing is signed)', async () => {
    const r = await post({ coin: 'Bitcoin', inputs: [input()], outputs: [output] })
    expect(r.approvals).toBe(1)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('Signing rejected by user')
    expect(r.signed).toBe(0)
  })

  test('multisig on, a valid multisig request still opens the card once', async () => {
    multisigOn()
    const r = await post({ coin: 'Bitcoin', inputs: [input({ scriptType: 'p2wsh', multisig: multisig([0, 5]) })], outputs: [output] })
    expect(r.approvals).toBe(1)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('Signing rejected by user')
  })

  test('multisig off: an invalid multisig request keeps the "enable it" 403, and the card never opens', async () => {
    const r = await post(hardenedSuffix)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe(BTC_MULTISIG_DISABLED)
    expect(r.approvals).toBe(0)
  })

  test('a locked wallet: an invalid request is 400 without asking to unlock; a valid one still needs the unlock', async () => {
    const bad = await post({ coin: 'Bitcoin', inputs: [input()], outputs: [] }, { locked: true })
    expect(bad.status).toBe(400)
    expect(bad.approvals).toBe(0)
    const good = await post({ coin: 'Bitcoin', inputs: [input()], outputs: [output] }, { locked: true })
    expect(good.status).toBe(423)
    expect(good.approvals).toBe(0)
  })

  test('an empty body keeps the gate\'s probe error, not a validation error', async () => {
    const r = await post({})
    expect(r.status).toBe(400)
    expect(r.data.error).toMatch(/^Missing signing payload/)
    expect(r.approvals).toBe(0)
  })
})
