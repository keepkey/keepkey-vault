/**
 * Segwit multisig (p2wsh, p2sh-p2wsh) over the REST API.
 *
 * hdwallet has no p2wsh script type: sending the name through gave a 500
 * "unhandled InputSriptType enum: p2wsh" on POST /utxo/sign-transaction and
 * POST /system/info/get-public-key. The device signs segwit multisig as
 * SPENDWITNESS / SPENDP2SHWITNESS carrying the multisig object, which is how
 * the app's own multisig flow sends it (firmwareMultisigType). Now:
 *   - sign-transaction sends p2wsh / p2sh-p2wsh as p2wpkh / p2sh-p2wpkh with the multisig object;
 *   - p2wsh without a multisig object, or a script type the device does not know, is a 400;
 *   - get-public-key with p2wsh / p2sh-p2wsh returns the standard xpub, as p2sh already does.
 *
 * The wallet is in memory: nothing reaches a device.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-utxo-p2wsh-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
const { HttpError } = await import('../src/bun/auth')
const { startRestApi } = await import('../src/bun/rest-api')
const S = await import('../src/bun/schemas')
const { BTC_MULTISIG_SETTING, deviceScriptType } = await import('../src/bun/btc-psbt/multisig-feature')
const { firmwareMultisigType } = await import('../src/bun/btc-psbt/multisig-cosign')

const H = 0x80000000
const P2WSH_PATH = [H + 48, H, H, H + 2, 0, 0]
const multisig = { m: 2, pubkeys: [{ xpub: 'xpub-a', addressNList: [0, 0] }, { xpub: 'xpub-b', addressNList: [0, 0] }], signatures: ['', ''] }
const spend = { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '1000', addressType: 'spend' }
const input = (scriptType: string, extra: Record<string, unknown> = {}) => ({ txid: 'a'.repeat(64), vout: 0, amount: '5000', addressNList: P2WSH_PATH, scriptType, multisig, ...extra })
const change = (scriptType: string, extra: Record<string, unknown> = {}) => ({ addressNList: [H + 48, H, H, H + 2, 1, 0], amount: '3000', addressType: 'change', isChange: true, scriptType, multisig, ...extra })

// What hdwallet's translateInputScriptType / translateOutputScriptType accept
// (modules/hdwallet packages/hdwallet-keepkey/src/utils.ts at 4b77959a).
const HDWALLET_INPUT_TYPES = ['cashaddr', 'p2pkh', 'p2sh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr']
const HDWALLET_OUTPUT_TYPES = ['p2pkh', 'p2sh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr']

beforeAll(() => { db.initDb() })
afterEach(() => { db.setSetting(BTC_MULTISIG_SETTING, '0') })
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

async function call(path: string, body: unknown) {
  const device = { signed: [] as any[], publicKeys: [] as any[], approvals: 0 }
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: false, isLocked: false,
    getDeviceState: () => ({ state: 'ready', firmwareVersion: '7.17.0', deviceId: 'utxo-p2wsh' }),
    getCachedFeaturesSnapshot: () => undefined,
    wallet: {
      btcSignTx: async (tx: any) => { device.signed.push(tx); return { serializedTx: '00', signatures: [] } },
      getPublicKeys: async (keys: any[]) => { device.publicKeys.push(...keys); return keys.map(() => ({ xpub: 'xpub-standard' })) },
    },
  })
  const auth: any = {
    requireAuth: (req: Request) => {
      if (!req.headers.get('authorization')) throw new HttpError(401, 'Unauthorized')
      return { name: 'p2wsh test', url: 'https://wallet.example.invalid' }
    },
    extractBearerToken: (req: Request) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
    validate: () => true,
    getAccount: () => undefined,
    saveAccount: () => {},
  }
  const server = startRestApi(engine, auth, 0, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    onSigningRequest: async () => { device.approvals++; return { approved: true } },
    onSigningDismissed: () => {},
  } as any, '127.0.0.1')
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: await res.json() as any, ...device }
  } finally { server.stop(true) }
}

describe('POST /utxo/sign-transaction with segwit multisig', () => {
  test('p2wsh transfer output with its multisig object reaches the device as p2wpkh', async () => {
    db.setSetting(BTC_MULTISIG_SETTING, '1')
    const transfer = change('p2wsh', { isChange: undefined, addressType: 'transfer' })
    const r = await call('/utxo/sign-transaction', { coin: 'Bitcoin', inputs: [input('p2wsh')], outputs: [transfer] })
    expect(r.status).toBe(200)
    expect(r.signed[0].outputs[0]).toMatchObject({ scriptType: 'p2wpkh', multisig, addressType: 'transfer' })
  })

  test('p2wsh: the device gets p2wpkh with the multisig object, inputs and change', async () => {
    db.setSetting(BTC_MULTISIG_SETTING, '1')
    const r = await call('/utxo/sign-transaction', { coin: 'Bitcoin', inputs: [input('p2wsh')], outputs: [spend, change('p2wsh')] })
    expect(r.status).toBe(200)
    expect(r.signed).toHaveLength(1)
    const [tx] = r.signed
    expect(tx.inputs[0]).toMatchObject({ scriptType: 'p2wpkh', multisig, addressNList: P2WSH_PATH })
    expect(tx.outputs[1]).toMatchObject({ scriptType: 'p2wpkh', multisig, isChange: true })
    expect(tx.outputs[0]).toEqual(spend)
  })

  test('p2sh-p2wsh: the device gets p2sh-p2wpkh with the multisig object', async () => {
    db.setSetting(BTC_MULTISIG_SETTING, '1')
    const r = await call('/utxo/sign-transaction', { coin: 'Bitcoin', inputs: [input('p2sh-p2wsh')], outputs: [spend, change('p2sh-p2wsh')] })
    expect(r.status).toBe(200)
    expect(r.signed[0].inputs[0]).toMatchObject({ scriptType: 'p2sh-p2wpkh', multisig })
    expect(r.signed[0].outputs[1]).toMatchObject({ scriptType: 'p2sh-p2wpkh', multisig })
  })

  test('p2sh multisig and single-sig requests reach the device unchanged', async () => {
    db.setSetting(BTC_MULTISIG_SETTING, '1')
    const p2sh = { coin: 'Bitcoin', inputs: [input('p2sh')], outputs: [spend, change('p2sh')] }
    const m = await call('/utxo/sign-transaction', p2sh)
    expect(m.status).toBe(200)
    expect(m.signed[0]).toMatchObject({ inputs: p2sh.inputs, outputs: p2sh.outputs })
    const single = { coin: 'Bitcoin', inputs: [input('p2wpkh', { multisig: undefined, addressNList: [H + 84, H, H, 0, 0] })], outputs: [spend] }
    const r = await call('/utxo/sign-transaction', single)
    expect(r.status).toBe(200)
    expect(r.signed[0].inputs[0].scriptType).toBe('p2wpkh')
    expect(r.signed[0].inputs[0].multisig).toBeUndefined()
  })

  const refused: [string, unknown, RegExp][] = [
    ['p2wsh input without a multisig object', { inputs: [input('p2wsh', { multisig: undefined })], outputs: [spend] }, /inputs\.0\.scriptType: p2wsh is a multisig script type and needs a multisig object/],
    ['p2sh-p2wsh input with multisig: null', { inputs: [input('p2sh-p2wsh', { multisig: null })], outputs: [spend] }, /inputs\.0\.scriptType: p2sh-p2wsh is a multisig script type/],
    ['p2wsh change output without a multisig object', { inputs: [input('p2wpkh', { multisig: undefined })], outputs: [spend, change('p2wsh', { multisig: undefined })] }, /outputs\.1\.scriptType: p2wsh is a multisig script type/],
    ['p2wsh change marked with a truthy isChange (1) and no multisig object', { inputs: [input('p2wpkh', { multisig: undefined })], outputs: [spend, change('p2wsh', { multisig: undefined, isChange: 1 })] }, /outputs\.1\.scriptType: p2wsh is a multisig script type/],
    ['p2wsh transfer output without a multisig object', { inputs: [input('p2wpkh', { multisig: undefined })], outputs: [spend, change('p2wsh', { multisig: undefined, isChange: undefined, addressType: 'transfer' })] }, /outputs\.1\.scriptType: p2wsh is a multisig script type/],
    ['p2wsh with an empty multisig object', { inputs: [input('p2wsh', { multisig: {} })], outputs: [spend] }, /inputs\.0\.multisig\.pubkeys: multisig needs 2 to 15 public keys/],
    ['p2wsh with m larger than the number of keys', { inputs: [input('p2wsh', { multisig: { ...multisig, m: 3 } })], outputs: [spend] }, /inputs\.0\.multisig\.m: multisig m must be an integer from 1 to 2/],
    ['cashaddr on a change output', { inputs: [input('p2pkh', { multisig: undefined })], outputs: [spend, change('cashaddr', { multisig: undefined })] }, /outputs\.1\.scriptType: unsupported script type/],
    ['an input script type the device does not know', { inputs: [input('bech32', { multisig: undefined })], outputs: [spend] }, /inputs\.0\.scriptType: unsupported script type/],
    ['a change script type the device does not know', { inputs: [input('p2wpkh', { multisig: undefined })], outputs: [spend, change('external', { multisig: undefined })] }, /outputs\.1\.scriptType: unsupported script type/],
  ]
  for (const [name, body, message] of refused) {
    test(`${name}: 400 before the card, never a 500`, async () => {
      db.setSetting(BTC_MULTISIG_SETTING, '1') // so the multisig-off 403 does not answer first
      const r = await call('/utxo/sign-transaction', { coin: 'Bitcoin', ...(body as object) })
      expect(r.status).toBe(400)
      expect(r.data.error).toMatch(message)
      expect(r.approvals).toBe(0)
      expect(r.signed).toHaveLength(0)
    })
  }

  test('a spend output to an address keeps any script type (the device never sees it)', () => {
    const body = { coin: 'Bitcoin', inputs: [input('p2wpkh', { multisig: undefined })], outputs: [{ ...spend, scriptType: 'p2wsh' }] }
    expect(S.UtxoSignTransactionRequest.safeParse(body).success).toBe(true)
  })
})

describe('POST /system/info/get-public-key with segwit multisig', () => {
  for (const scriptType of ['p2wsh', 'p2sh-p2wsh']) {
    test(`${scriptType}: the standard xpub, asked for as p2pkh like p2sh`, async () => {
      const r = await call('/system/info/get-public-key', { address_n: [H + 48, H, H, H + 2], script_type: scriptType })
      expect(r.status).toBe(200)
      expect(r.data.xpub).toBe('xpub-standard')
      expect(r.publicKeys[0].scriptType).toBe('p2pkh')
    })
  }

  test('an empty script_type still means the default, as before', async () => {
    const r = await call('/system/info/get-public-key', { address_n: [H + 44, H, H], script_type: '' })
    expect(r.status).toBe(200)
    expect(r.publicKeys[0].scriptType).toBeUndefined()
  })

  test('other script types reach the device unchanged', async () => {
    const r = await call('/system/info/get-public-key', { address_n: [H + 84, H, H], script_type: 'p2wpkh' })
    expect(r.publicKeys[0].scriptType).toBe('p2wpkh')
  })

  test('a script type the device does not know is a 400, never a 500', async () => {
    const r = await call('/system/info/get-public-key', { address_n: [H + 84, H, H], script_type: 'bech32' })
    expect(r.status).toBe(400)
    expect(r.data.error).toMatch(/script_type/)
    expect(r.publicKeys).toHaveLength(0)
  })
})

describe('script type mapping', () => {
  test('every accepted script type reaches hdwallet as a type it translates', () => {
    for (const t of S.UTXO_SCRIPT_TYPES) {
      expect(HDWALLET_INPUT_TYPES).toContain(deviceScriptType(t))
      if (t !== 'cashaddr') expect(HDWALLET_OUTPUT_TYPES).toContain(deviceScriptType(t)) // cashaddr is refused on change outputs
    }
  })

  test('matches the app\'s own multisig flow', () => {
    for (const t of ['p2wsh', 'p2sh-p2wsh', 'p2sh'] as const) expect(deviceScriptType(t)).toBe(firmwareMultisigType(t))
  })
})
