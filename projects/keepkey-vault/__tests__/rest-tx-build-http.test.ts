/**
 * POST /api/v2/tx/build over real HTTP routing, a real AuthStore pairing in an
 * isolated SQLite profile, and an in-memory engine. The buildTxHeadless hook
 * returns real builder output (txbuilder buildTx with fixture Pioneer objects),
 * the same thing index.ts's buildTxForCurrentWallet returns.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-tx-build-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
const { AuthStore } = await import('../src/bun/auth')
const { startRestApi } = await import('../src/bun/rest-api')
const { buildTx } = await import('../src/bun/txbuilder')
const { CHAINS } = await import('../src/shared/chains')
const S = await import('../src/bun/schemas')
const { txBuildAccountPath } = await import('../src/bun/rest-tx-build')

const KEY = 'tx-build-pairing'
const chain = (id: string) => CHAINS.find(c => c.id === id)!
const COSMOS_SIGNER = 'cosmos1rgf4z0qljnsaq2tt5dzr058snqahfkha797w54'
const COSMOS_TO = 'cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du'
const BTC_TO = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const XRP_TO = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const LTC_TO = 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9'
const H = 0x80000000
const utxoSource = (path: string) => ({
  ListUnspent: async () => ({ data: [{ txid: 'c00b24b617db136acba4d831e31727319e6917123934f9f8b5253c7f0e89a5b6', vout: 0, value: '50000000', path, hex: '00' }] }),
  GetFeeRateByNetwork: async () => ({ data: { slow: 1, average: 2, fast: 5 } }),
  GetPubkeyInfo: async () => ({ data: [] }),
})

// Fixture data sources, the same shapes the builder suites use.
const PIONEER: Record<string, any> = {
  bitcoin: {
    ListUnspent: async () => ({ data: [{ txid: 'c00b24b617db136acba4d831e31727319e6917123934f9f8b5253c7f0e89a5b6', vout: 0, value: '500000', path: "m/84'/0'/0'/0/0", hex: '00' }] }),
    GetFeeRateByNetwork: async () => ({ data: { slow: 1, average: 2, fast: 5 } }),
    GetPubkeyInfo: async () => ({ data: [] }),
  },
  cosmos: { GetAccountInfo: async () => ({ data: { account: { account_number: '17', sequence: '2' } } }) },
  ripple: { GetAccountInfo: async () => ({ data: { Sequence: 7, ledger_index_current: 900, Balance: '5000000' } }) },
}
/** A named UTXO account: what buildTxHeadless + buildTxForCurrentWallet hand the
 *  builder (one device-derived xpub, its script type, its account path). */
const namedAccountBuild = (r: any) => buildTx(utxoSource("m/49'/2'/0'/0/0"), chain(r.chainId), {
  chainId: r.chainId, to: r.to, amount: r.isMax ? '0' : r.amount, isMax: r.isMax, feeLevel: 3,
  xpub: 'xpub-fixture', scriptTypeOverride: r.scriptType, accountPath: txBuildAccountPath(chain(r.chainId), r.scriptType, r.accountIndex),
})
/** What buildTxForCurrentWallet does after deriving the sender. */
const realBuild = (r: any) => buildTx(PIONEER[r.chainId], chain(r.chainId), {
  chainId: r.chainId, to: r.to, amount: r.isMax ? '0' : r.amount, isMax: r.isMax, memo: r.memo, feeLevel: 3,
  ...(r.chainId === 'bitcoin' ? { xpub: 'zpub-fixture', accountPath: [0x80000054, 0x80000000, 0x80000000] } : { fromAddress: r.chainId === 'cosmos' ? COSMOS_SIGNER : 'rSender' }),
})

beforeAll(() => { db.initDb(); db.storePairing(KEY, { name: 'QA BEX', url: 'chrome-extension://qa', imageUrl: '', addedOn: Date.now(), lastUsedOn: Date.now() }) })
afterEach(() => { db.setSetting('offline_mode', '0') })
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

async function call(body: unknown, options: { auth?: boolean; access?: string | null; locked?: boolean; hook?: (r: any) => Promise<any> } = {}) {
  const received: any[] = []
  const auth = new AuthStore()
  const engine: any = Object.assign(new EventEmitter(), {
    wallet: {}, isEmulator: false, isPassphraseWallet: false, wipeInProgress: false, wipeOnReconnect: false,
    isLocked: !!options.locked,
    getDeviceState: () => ({ state: 'ready', firmwareVersion: '7.17.0', deviceId: 'tx-build-test', capabilities: [] }),
    getCachedFeaturesSnapshot: () => undefined,
  })
  const server = startRestApi(engine, auth, 0, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    onSigningRequest: async () => ({ approved: false }) as any, onSigningDismissed: () => {},
    buildTxHeadless: async (r: any) => { received.push(r); return (options.hook ?? realBuild)(r) },
  } as any, '127.0.0.1')
  try {
    const access = options.access === undefined ? 'foreground' : options.access
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v2/tx/build`, {
      method: 'POST', body: JSON.stringify(body), headers: {
        'Content-Type': 'application/json',
        ...(options.auth === false ? {} : { Authorization: `Bearer ${KEY}` }),
        ...(access ? { 'X-KeepKey-Device-Access': access } : {}),
      },
    })
    return { status: res.status, body: await res.json() as any, received, auth }
  } finally {
    server.stop(true)
  }
}

const atom = { caip: chain('cosmos').caip, to: COSMOS_TO, amount: '1.5', memo: 'EXCHANGE-ID-42' }

describe('POST /api/v2/tx/build', () => {
  test('no pairing key is refused before anything is built', async () => {
    const r = await call(atom, { auth: false })
    expect(r.status).toBe(401)
    expect(r.received).toEqual([])
  })

  test('an asset outside the allowlist is 400 UNSUPPORTED_ASSET', async () => {
    const r = await call({ ...atom, caip: 'cosmos:thorchain-mainnet-v1/denom:tcy' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('UNSUPPORTED_ASSET')
    expect(r.received).toEqual([])
  })

  test('a malformed body is 400 INVALID_REQUEST', async () => {
    const r = await call({ caip: atom.caip })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('INVALID_REQUEST')
  })

  test('a locked device is 423 and nothing is built', async () => {
    const r = await call(atom, { locked: true })
    expect(r.status).toBe(423)
    expect(r.received).toEqual([])
  })

  test('without foreground device access it is 423 DEVICE_ACCESS_REQUIRED', async () => {
    const r = await call(atom, { access: null })
    expect(r.status).toBe(423)
    expect(r.body.code).toBe('DEVICE_ACCESS_REQUIRED')
    expect(r.received).toEqual([])
  })

  test('offline mode is 503', async () => {
    db.setSetting('offline_mode', '1')
    const r = await call(atom)
    expect(r.status).toBe(503)
    expect(r.received).toEqual([])
  })

  test('client-supplied xpubs, swap flags, pubkeys and fee levels never reach the builder', async () => {
    const r = await call({ ...atom, xpubOverride: 'xpub-attacker', isSwapDeposit: true, pubkeys: [{ pubkey: 'x' }], feeLevel: 10, scriptTypeOverride: 'p2pkh', accountPath: [1, 2, 3] })
    expect(r.status).toBe(200)
    expect(r.received).toHaveLength(1)
    expect(Object.keys(r.received[0]).sort()).toEqual(['accountIndex', 'amount', 'chainId', 'isMax', 'memo', 'to'])
    expect(r.received[0]).toEqual({ chainId: 'cosmos', to: COSMOS_TO, amount: '1.5', isMax: false, memo: 'EXCHANGE-ID-42', accountIndex: 0 })
    expect(r.body.signDoc).toBeUndefined()
    expect(r.body.signBody.signDoc.msgs[0].type).toBe('cosmos-sdk/MsgSend')
  })

  test('a builder failure is 422 BUILD_FAILED with its message verbatim', async () => {
    const r = await call(atom, { hook: async () => { throw new Error('Insufficient funds') } })
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('Insufficient funds')
    expect(r.body.code).toBe('BUILD_FAILED')
  })

  test('an upstream HTTP error from a data fetch is 422 BUILD_FAILED, never its own status', async () => {
    // swagger-client (pioneer-client) throws Error(statusText) with .status = upstream status.
    for (const status of [404, 401, 502]) {
      const r = await call(atom, { hook: async () => { throw Object.assign(new Error('Not Found'), { status }) } })
      expect(r.status).toBe(422)
      expect(r.body.error).toBe('Not Found')
      expect(r.body.code).toBe('BUILD_FAILED')
    }
  })

  test('cosmos: 200 with a sign body /cosmos/sign-amino accepts, and the signer is registered', async () => {
    const r = await call(atom)
    expect(r.status).toBe(200)
    expect(r.body.signRoute).toBe('/cosmos/sign-amino')
    expect(S.CosmosAminoSignRequest.parse(r.body.signBody)).toStrictEqual(r.body.signBody)
    expect(r.body.summary).toEqual({ to: COSMOS_TO, amount: '1.5', fee: '0.0075', symbol: 'ATOM', memo: 'EXCHANGE-ID-42' })
    // The sign route resolves the signer through this registry ("Unrecognized address" otherwise).
    expect(r.auth.getAccount(r.body.signBody.signerAddress)).toEqual({ addressNList: chain('cosmos').defaultPath })
  })

  test('bitcoin: 200 with a body /utxo/sign-transaction accepts unchanged', async () => {
    const r = await call({ caip: chain('bitcoin').caip, to: BTC_TO, amount: '0.001' })
    expect(r.status).toBe(200)
    expect(r.body.signRoute).toBe('/utxo/sign-transaction')
    expect(S.UtxoSignTransactionRequest.parse(r.body.signBody)).toStrictEqual(r.body.signBody)
    expect(r.body.summary.amount).toBe('0.001')
    expect(r.body.summary.symbol).toBe('BTC')
  })

  test('litecoin: the named account (scriptType + accountIndex) reaches the builder and is what gets built', async () => {
    const r = await call({ caip: chain('litecoin').caip, to: LTC_TO, amount: '0.001', scriptType: 'p2sh-p2wpkh', accountIndex: 1 }, { hook: namedAccountBuild })
    expect(r.status).toBe(200)
    expect(r.received).toEqual([{ chainId: 'litecoin', to: LTC_TO, amount: '0.001', isMax: false, memo: undefined, accountIndex: 1, scriptType: 'p2sh-p2wpkh' }])
    expect(S.UtxoSignTransactionRequest.parse(r.body.signBody)).toStrictEqual(r.body.signBody)
    const change = r.body.signBody.outputs.find((o: any) => o.addressType === 'change')
    expect(change.scriptType).toBe('p2sh-p2wpkh')
    expect(change.addressNList.slice(0, 4)).toEqual([H + 49, H + 2, H + 1, 1])
    for (const input of r.body.signBody.inputs) expect(input.addressNList.slice(0, 3)).toEqual([H + 49, H + 2, H + 1])
    expect(r.body.summary).toMatchObject({ to: LTC_TO, amount: '0.001', symbol: 'LTC', scriptType: 'p2sh-p2wpkh', accountIndex: 1 })
  })

  test('a build that does not spend the named account is 422 BUILD_FAILED, never returned', async () => {
    // Hook spends account 0 while the extension asked for account 1.
    const r = await call({ caip: chain('litecoin').caip, to: LTC_TO, amount: '0.001', scriptType: 'p2sh-p2wpkh', accountIndex: 1 },
      { hook: (q: any) => namedAccountBuild({ ...q, accountIndex: 0 }) })
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('BUILD_FAILED')
    expect(r.body.signBody).toBeUndefined()
  })

  test('a script type Desktop does not spend for that chain is 400 SCRIPT_TYPE_UNSUPPORTED before anything is built', async () => {
    for (const body of [
      { caip: chain('dogecoin').caip, to: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', amount: '2', scriptType: 'p2wpkh' },
      { caip: chain('litecoin').caip, to: LTC_TO, amount: '1', scriptType: 'p2tr' },
      { caip: chain('bitcoin').caip, to: BTC_TO, amount: '1', scriptType: 'p2wsh' },
      { ...atom, scriptType: 'p2pkh' },
    ]) {
      const r = await call(body)
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('SCRIPT_TYPE_UNSUPPORTED')
      expect(r.received).toEqual([])
    }
  })

  test('an ACCOUNT_NOT_FOUND from Desktop is the client\'s 400, with its code', async () => {
    const { HttpError } = await import('../src/bun/auth')
    const r = await call({ caip: chain('bitcoin').caip, to: BTC_TO, amount: '0.001', scriptType: 'p2wpkh', accountIndex: 7 },
      { hook: async () => { throw new HttpError(400, 'KeepKey Desktop has no Bitcoin account 7', { code: 'ACCOUNT_NOT_FOUND' }) } })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('ACCOUNT_NOT_FOUND')
  })

  test('xrp: 200 with a body /xrp/sign-transaction accepts unchanged, tag in the summary', async () => {
    const r = await call({ caip: chain('ripple').caip, to: XRP_TO, amount: '1', memo: '104857' })
    expect(r.status).toBe(200)
    expect(r.body.signRoute).toBe('/xrp/sign-transaction')
    expect(S.XrpSignRequest.parse(r.body.signBody)).toStrictEqual(r.body.signBody)
    expect(r.body.summary).toEqual({ to: XRP_TO, amount: '1', fee: '0.001', symbol: 'XRP', destinationTag: '104857' })
  })
})
