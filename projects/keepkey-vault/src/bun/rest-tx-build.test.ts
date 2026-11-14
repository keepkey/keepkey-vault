/**
 * POST /api/v2/tx/build mapping (browser extension builds through Desktop).
 * Every response here comes from the real builders (buildTx dispatcher) fed the
 * same kind of fixture Pioneer objects the builder suites use. The guard that
 * matters: the signBody survives the sign route's own zod .strip() unchanged,
 * so nothing Desktop built is silently dropped before the device signs it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { CHAINS } from '../shared/chains'
import type { BtcAccountSet } from '../shared/types'
import * as S from './schemas'
import { buildTx } from './txbuilder'
import { TX_BUILD_CAIPS, btcXpubForAccount, toTxBuildResponse, txBuildAccountPath, validateTxBuildRequest } from './rest-tx-build'

const chain = (id: string) => CHAINS.find(c => c.id === id)!
const caipOf = (id: string) => chain(id).caip
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

// ── Fixture builder inputs (same shapes as utxo-taproot / cosmos / xrp suites) ──
const utxo = (path: string, value: string) => ({
  txid: 'c00b24b617db136acba4d831e31727319e6917123934f9f8b5253c7f0e89a5b6',
  vout: 0, value, confirmations: 12, path, hex: '00',
})
const utxoPioneer = (u: any) => ({
  ListUnspent: async () => ({ data: [u] }),
  GetFeeRateByNetwork: async () => ({ data: { slow: 1, average: 2, fast: 5 } }),
  GetPubkeyInfo: async () => ({ data: [] }),
})
const cosmosPioneer = {
  GetAccountInfo: async () => ({ data: { account: { account_number: '17', sequence: '2' } } }),
  GetPortfolioBalances: async () => ({ data: { balances: [{ balance: '100' }] } }),
}
const xrpPioneer = {
  GetAccountInfo: async () => ({ data: { Sequence: 7, ledger_index_current: 900, Balance: '5000000', OwnerCount: 0 } }),
}
const SIGNERS: Record<string, string> = {
  cosmos: 'cosmos1g9el7lzjwh9yun2c4jjzhy09j98vkhfxa4ww3e',
  osmosis: 'osmo1g9el7lzjwh9yun2c4jjzhy09j98vkhfxl5mmyl',
  thorchain: 'thor1g9el7lzjwh9yun2c4jjzhy09j98vkhfxfhgnzx',
  mayachain: 'maya1g9el7lzjwh9yun2c4jjzhy09j98vkhfxh5zv2m',
}
const BTC_TO = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const BCH_LEGACY = '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu'
const BCH_CASHADDR = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
const XRP_TO = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'

async function buildBtc(isMax = false) {
  const c = chain('bitcoin')
  return { c, built: await buildTx(utxoPioneer(utxo("m/84'/0'/0'/0/0", '500000')), c, {
    chainId: 'bitcoin', to: BTC_TO, amount: isMax ? '0' : '0.001', isMax, feeLevel: 3,
    xpub: 'zpub-fixture', accountPath: [0x80000054, 0x80000000, 0x80000000], scriptTypeOverride: 'p2wpkh',
  }) }
}
/** What index.ts buildTxHeadless hands the builder for a named account: one xpub,
 *  its script type, and its account path. The UTXO fixture path is account 0, as
 *  blockbook reports it; the builder rewrites it onto the named account. */
async function buildAccount(id: string, to: string, scriptType: string, accountIndex: number, utxoPath: string, isMax = false) {
  const c = chain(id)
  return { c, built: await buildTx(utxoPioneer(utxo(utxoPath, '5000000000')), c, {
    chainId: id, to, amount: isMax ? '0' : '0.001', isMax, feeLevel: 3,
    xpub: 'xpub-fixture', scriptTypeOverride: scriptType, accountPath: txBuildAccountPath(c, scriptType, accountIndex),
  }) }
}
async function buildUtxoChain(id: string, to: string, amount: string, path: string, value: string) {
  const c = chain(id)
  return { c, built: await buildTx(utxoPioneer(utxo(path, value)), c, { chainId: id, to, amount, feeLevel: 3, xpub: 'xpub-fixture' }) }
}
async function buildCosmosFamily(id: string, amount: string, memo?: string, isMax = false) {
  const c = chain(id)
  return { c, built: await buildTx(cosmosPioneer, c, {
    chainId: id, to: SIGNERS[id], amount, memo, isMax, feeLevel: 3, fromAddress: SIGNERS[id],
  }) }
}
async function buildXrp(memo?: string, isMax = false) {
  const c = chain('ripple')
  return { c, built: await buildTx(xrpPioneer, c, { chainId: 'ripple', to: XRP_TO, amount: isMax ? '0' : '1.25', memo, isMax, fromAddress: 'rSender' }) }
}

/** A body POSTed over HTTP must survive JSON and the sign route's schema unchanged. */
function expectSignRouteKeepsEverything(signRoute: string, signBody: unknown) {
  expect(JSON.parse(JSON.stringify(signBody))).toStrictEqual(signBody)
  const schema = signRoute === '/utxo/sign-transaction' ? S.UtxoSignTransactionRequest
    : signRoute === '/xrp/sign-transaction' ? S.XrpSignRequest
    : S.CosmosAminoSignRequest
  expect(schema.parse(signBody)).toStrictEqual(signBody as any)
}

describe('toTxBuildResponse: UTXO', () => {
  test('BTC: sign route, untouched sign body, summary read from the built outputs', async () => {
    const { c, built } = await buildBtc()
    const out = toTxBuildResponse(c, built)
    expect(out.signRoute).toBe('/utxo/sign-transaction')
    expectSignRouteKeepsEverything(out.signRoute, out.signBody)
    const u = built.unsignedTx
    expect(out.signBody).toStrictEqual({ coin: 'Bitcoin', inputs: u.inputs, outputs: u.outputs, version: 1, locktime: 0 })
    expect(out.summary).toStrictEqual({ to: BTC_TO, amount: '0.001', fee: built.fee, symbol: 'BTC', scriptType: 'p2wpkh', accountIndex: 0 })
    expect((out.signBody as any).outputs.some((o: any) => o.isChange && o.addressType === 'change')).toBe(true)
  })

  test('BTC MAX (amount 0): no change output, summary shows the swept amount', async () => {
    const { c, built } = await buildBtc(true)
    const out = toTxBuildResponse(c, built)
    const outputs = (out.signBody as any).outputs
    expect(outputs).toHaveLength(1)
    expect(outputs.some((o: any) => o.isChange)).toBe(false)
    const feeSats = 500000 - Number(outputs[0].amount)
    expect(feeSats).toBeGreaterThan(0)
    expect(out.summary.amount).toBe((Number(outputs[0].amount) / 1e8).toString())
    expect(Number(out.summary.fee)).toBeCloseTo(feeSats / 1e8, 10)
  })

  test('BCH: legacy recipient is shown and signed as cashaddr', async () => {
    const { c, built } = await buildUtxoChain('bitcoincash', BCH_LEGACY, '0.001', "m/44'/145'/0'/0/0", '500000')
    const out = toTxBuildResponse(c, built)
    expect(out.signRoute).toBe('/utxo/sign-transaction')
    expectSignRouteKeepsEverything(out.signRoute, out.signBody)
    expect((out.signBody as any).coin).toBe('BitcoinCash')
    expect(out.summary.to).toBe(BCH_CASHADDR)
    expect(out.summary.symbol).toBe('BCH')
  })

  test('DOGE: hard-coded 1 DOGE minimum fee is the summary fee', async () => {
    const { c, built } = await buildUtxoChain('dogecoin', 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', '2.5', "m/44'/3'/0'/0/0", '1000000000')
    const out = toTxBuildResponse(c, built)
    expectSignRouteKeepsEverything(out.signRoute, out.signBody)
    expect(out.summary).toStrictEqual({ to: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', amount: '2.5', fee: '1', symbol: 'DOGE', scriptType: 'p2pkh', accountIndex: 0 })
  })
})

describe('toTxBuildResponse: the named UTXO account', () => {
  const LTC_TO = 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9'
  const H = 0x80000000
  const cases = [
    { id: 'litecoin', to: LTC_TO, scriptType: 'p2sh-p2wpkh', accountIndex: 1, utxoPath: "m/49'/2'/0'/0/3", account: [H + 49, H + 2, H + 1] },
    { id: 'litecoin', to: LTC_TO, scriptType: 'p2pkh', accountIndex: 0, utxoPath: "m/44'/2'/0'/0/0", account: [H + 44, H + 2, H] },
    { id: 'bitcoin', to: BTC_TO, scriptType: 'p2pkh', accountIndex: 2, utxoPath: "m/44'/0'/0'/0/1", account: [H + 44, H, H + 2] },
    { id: 'bitcoin', to: BTC_TO, scriptType: 'p2tr', accountIndex: 1, utxoPath: "m/86'/0'/0'/0/0", account: [H + 86, H, H + 1] },
    { id: 'dogecoin', to: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', scriptType: 'p2pkh', accountIndex: 3, utxoPath: "m/44'/3'/0'/0/0", account: [H + 44, H + 3, H + 3] },
  ]
  for (const k of cases) {
    test(`${k.id} ${k.scriptType} account ${k.accountIndex}: inputs and change stay on that account; the summary says so`, async () => {
      const { c, built } = await buildAccount(k.id, k.to, k.scriptType, k.accountIndex, k.utxoPath)
      const out = toTxBuildResponse(c, built, { scriptType: k.scriptType as any, accountIndex: k.accountIndex })
      expectSignRouteKeepsEverything(out.signRoute, out.signBody)
      const body = out.signBody as any
      for (const input of body.inputs) {
        expect(input.scriptType).toBe(k.scriptType)
        expect(input.addressNList.slice(0, 3)).toEqual(k.account)
      }
      const change = body.outputs.find((o: any) => o.addressType === 'change')
      expect(change.scriptType).toBe(k.scriptType)
      expect(change.addressNList.slice(0, 4)).toEqual([...k.account, 1])
      expect(out.summary.scriptType).toBe(k.scriptType)
      expect(out.summary.accountIndex).toBe(k.accountIndex)
    })
  }

  test('a build from another account than the one requested is refused (422 BUILD_FAILED), not returned', async () => {
    const { c, built } = await buildAccount('litecoin', LTC_TO, 'p2wpkh', 0, "m/84'/2'/0'/0/0")
    for (const requested of [{ scriptType: 'p2wpkh', accountIndex: 1 }, { scriptType: 'p2pkh', accountIndex: 0 }] as const) {
      try { toTxBuildResponse(c, built, requested); throw new Error('accepted') } catch (e: any) {
        expect(e.status).toBe(422)
        expect(e.details?.code).toBe('BUILD_FAILED')
      }
    }
    expect(toTxBuildResponse(c, built, { scriptType: 'p2wpkh', accountIndex: 0 }).summary.accountIndex).toBe(0)
  })

  test('inputs from more than one account: no scriptType/accountIndex claimed in the summary', async () => {
    const { c, built } = await buildAccount('litecoin', LTC_TO, 'p2wpkh', 0, "m/84'/2'/0'/0/0")
    const u = built.unsignedTx
    const mixed = { ...built, unsignedTx: { ...u, inputs: [...u.inputs, { ...u.inputs[0], vout: 1, scriptType: 'p2pkh', addressNList: [H + 44, H + 2, H, 0, 0] }] } }
    const out = toTxBuildResponse(c, mixed)
    expect(out.summary.scriptType).toBeUndefined()
    expect(out.summary.accountIndex).toBeUndefined()
    expect(() => toTxBuildResponse(c, mixed, { scriptType: 'p2wpkh', accountIndex: 0 })).toThrow()
  })

  test('MAX from a named account: no change output, the inputs still name the account', async () => {
    const { c, built } = await buildAccount('litecoin', LTC_TO, 'p2sh-p2wpkh', 1, "m/49'/2'/0'/0/0", true)
    const out = toTxBuildResponse(c, built, { scriptType: 'p2sh-p2wpkh', accountIndex: 1 })
    expect((out.signBody as any).outputs.some((o: any) => o.addressType === 'change')).toBe(false)
    expect(out.summary.scriptType).toBe('p2sh-p2wpkh')
    expect(out.summary.accountIndex).toBe(1)
  })
})

describe('toTxBuildResponse: cosmos family', () => {
  const cases = [
    { id: 'cosmos', route: '/cosmos/sign-amino', amount: '1.5', base: '1500000', fee: '0.0075', symbol: 'ATOM' },
    { id: 'osmosis', route: '/osmosis/sign-amino', amount: '0.000001', base: '1', fee: '0.035', symbol: 'OSMO' },
    { id: 'thorchain', route: '/thorchain/sign-amino-transfer', amount: '1.5', base: '150000000', fee: '0.02', symbol: 'RUNE' },
    { id: 'mayachain', route: '/mayachain/sign-amino-transfer', amount: '2.0000000001', base: '20000000001', fee: '0.2', symbol: 'CACAO' },
  ]
  for (const k of cases) {
    test(`${k.id}: ${k.route}, amino signDoc from the builder, ${chain(k.id).decimals}-decimal summary`, async () => {
      const { c, built } = await buildCosmosFamily(k.id, k.amount, 'EXCHANGE-ID-42')
      const out = toTxBuildResponse(c, built)
      expect(out.signRoute).toBe(k.route as any)
      expectSignRouteKeepsEverything(out.signRoute, out.signBody)
      const u = built.unsignedTx
      expect(out.signBody).toStrictEqual({
        signerAddress: SIGNERS[k.id],
        signDoc: { account_number: '17', chain_id: c.chainId, fee: u.tx.fee, memo: 'EXCHANGE-ID-42', msgs: u.tx.msg, sequence: '2' },
      })
      expect((out.signBody as any).signDoc.msgs[0].value.amount[0].amount).toBe(k.base)
      expect(out.summary).toStrictEqual({ to: SIGNERS[k.id], amount: k.amount, fee: k.fee, symbol: k.symbol, memo: 'EXCHANGE-ID-42' })
    })
  }

  test('MAX (amount 0) builds the reserved balance and the summary reports it', async () => {
    const { c, built } = await buildCosmosFamily('thorchain', '0', undefined, true)
    const out = toTxBuildResponse(c, built)
    // 100 RUNE minus 2 x 0.02 RUNE native-fee reserve.
    expect(out.summary.amount).toBe('99.96')
    expect(out.summary.memo).toBeUndefined()
  })
})

describe('toTxBuildResponse: XRP', () => {
  test('digits memo becomes a destination tag; body is the builder output without flags', async () => {
    const { c, built } = await buildXrp('104857')
    const out = toTxBuildResponse(c, built)
    expect(out.signRoute).toBe('/xrp/sign-transaction')
    expectSignRouteKeepsEverything(out.signRoute, out.signBody)
    const { flags: _flags, ...rest } = built.unsignedTx
    expect(out.signBody).toStrictEqual(rest)
    expect(out.summary).toStrictEqual({ to: XRP_TO, amount: '1.25', fee: '0.001', symbol: 'XRP', destinationTag: '104857' })
  })

  test('MAX (amount 0) sends what the live reserves allow', async () => {
    globalThis.fetch = (async () => Response.json({ result: { state: { validated_ledger: { reserve_base: 1000000, reserve_inc: 200000 } } } })) as unknown as typeof fetch
    const { c, built } = await buildXrp(undefined, true)
    const out = toTxBuildResponse(c, built)
    expect(out.summary.amount).toBe('3.999')
    expect(out.summary.destinationTag).toBeUndefined()
  })
})

// ── Request validation ───────────────────────────────────────────────────

function code(fn: () => unknown): string | undefined {
  try { fn() } catch (e: any) { expect(e.status).toBe(400); return e.details?.code }
  return undefined
}
const req = (id: string, extra: Record<string, unknown> = {}) => ({ caip: caipOf(id), to: '', amount: '1', ...extra })
const VALID_TO: Record<string, string> = {
  bitcoin: BTC_TO, bitcoincash: BCH_CASHADDR, litecoin: 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
  dogecoin: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', dash: 'XpESxaUmonkq8RaLLp46Brx2K39ggQe226',
  cosmos: SIGNERS.cosmos, osmosis: SIGNERS.osmosis, thorchain: SIGNERS.thorchain, mayachain: SIGNERS.mayachain, ripple: XRP_TO,
}

describe('validateTxBuildRequest', () => {
  test('allowlist is exactly the ten native assets, each matching its Desktop chain', () => {
    expect(Object.keys(TX_BUILD_CAIPS)).toHaveLength(10)
    for (const [caip, id] of Object.entries(TX_BUILD_CAIPS)) {
      expect(caipOf(id)).toBe(caip)
      const { chain: c, request } = validateTxBuildRequest(req(id, { to: VALID_TO[id] }), CHAINS)
      expect(c.id).toBe(id)
      expect(request).toStrictEqual({ chainId: id, to: VALID_TO[id], amount: '1', isMax: false, memo: undefined, accountIndex: 0 })
    }
  })

  test('unknown, token and EVM caips are refused as UNSUPPORTED_ASSET', () => {
    for (const caip of ['cosmos:thorchain-mainnet-v1/denom:tcy', 'eip155:1/slip44:60', 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133', 'nope']) {
      expect(code(() => validateTxBuildRequest({ caip, to: SIGNERS.thorchain, amount: '1' }, CHAINS))).toBe('UNSUPPORTED_ASSET')
    }
  })

  test('a recipient from another family is INVALID_ADDRESS, named by symbol', () => {
    for (const [id, to] of [['bitcoin', SIGNERS.cosmos], ['litecoin', BTC_TO], ['dogecoin', XRP_TO], ['dash', 'D'], ['bitcoincash', 'xyz'],
      ['cosmos', SIGNERS.osmosis], ['osmosis', SIGNERS.cosmos], ['thorchain', SIGNERS.mayachain], ['mayachain', SIGNERS.thorchain], ['ripple', BTC_TO]]) {
      try { validateTxBuildRequest(req(id, { to }), CHAINS); throw new Error('accepted') } catch (e: any) {
        expect(e.details?.code).toBe('INVALID_ADDRESS')
        expect(e.message).toBe(`Invalid ${chain(id).symbol} address`)
      }
    }
  })

  test('amount: too many decimals, zero, junk, or missing without isMax is INVALID_AMOUNT', () => {
    for (const [id, amount] of [['bitcoin', '0.000000001'], ['cosmos', '0.0000001'], ['ripple', '1.0000001'], ['bitcoin', '0'], ['bitcoin', '0.0'],
      ['bitcoin', '-1'], ['bitcoin', '1e-3'], ['bitcoin', 'abc'], ['bitcoin', ''], ['bitcoin', undefined]] as const) {
      expect(code(() => validateTxBuildRequest(req(id, { to: VALID_TO[id], amount }), CHAINS))).toBe('INVALID_AMOUNT')
    }
    // Exactly chain.decimals fraction digits is fine; MAX ignores the amount.
    expect(validateTxBuildRequest(req('mayachain', { to: VALID_TO.mayachain, amount: '0.0000000001' }), CHAINS).request.amount).toBe('0.0000000001')
    const max = validateTxBuildRequest(req('bitcoin', { to: BTC_TO, amount: undefined, isMax: true }), CHAINS).request
    expect(max.isMax).toBe(true)
    expect(max.amount).toBeUndefined()
  })

  test('memo: refused on UTXO, blank means absent, forwarded on cosmos and XRP', () => {
    for (const id of ['bitcoin', 'bitcoincash', 'litecoin', 'dogecoin', 'dash']) {
      expect(code(() => validateTxBuildRequest(req(id, { to: VALID_TO[id], memo: 'hello' }), CHAINS))).toBe('MEMO_UNSUPPORTED')
    }
    expect(validateTxBuildRequest(req('bitcoin', { to: BTC_TO, memo: '   ' }), CHAINS).request.memo).toBeUndefined()
    expect(validateTxBuildRequest(req('ripple', { to: XRP_TO, memo: '104857' }), CHAINS).request.memo).toBe('104857')
    expect(validateTxBuildRequest(req('cosmos', { to: SIGNERS.cosmos, memo: 'EXCHANGE-ID-42' }), CHAINS).request.memo).toBe('EXCHANGE-ID-42')
  })

  test('accountIndex > 0: bitcoin, or any UTXO chain naming its script type; otherwise ACCOUNT_UNSUPPORTED rather than spend account 0', () => {
    expect(code(() => validateTxBuildRequest(req('cosmos', { to: SIGNERS.cosmos, accountIndex: 1 }), CHAINS))).toBe('ACCOUNT_UNSUPPORTED')
    expect(code(() => validateTxBuildRequest(req('ripple', { to: XRP_TO, accountIndex: 1 }), CHAINS))).toBe('ACCOUNT_UNSUPPORTED')
    // Without a script type Desktop spends every LTC account-0 type at once: it cannot honor account 2.
    expect(code(() => validateTxBuildRequest(req('litecoin', { to: VALID_TO.litecoin, accountIndex: 2 }), CHAINS))).toBe('ACCOUNT_UNSUPPORTED')
    expect(validateTxBuildRequest(req('bitcoin', { to: BTC_TO, accountIndex: 3 }), CHAINS).request.accountIndex).toBe(3)
    for (const [id, scriptType] of [['litecoin', 'p2wpkh'], ['dogecoin', 'p2pkh'], ['dash', 'p2pkh'], ['bitcoincash', 'p2pkh'], ['bitcoin', 'p2sh-p2wpkh']]) {
      const { request } = validateTxBuildRequest(req(id, { to: VALID_TO[id], accountIndex: 2, scriptType }), CHAINS)
      expect(request).toStrictEqual({ chainId: id, to: VALID_TO[id], amount: '1', isMax: false, memo: undefined, accountIndex: 2, scriptType })
    }
  })

  test('scriptType: exactly the account types Desktop spends for that chain', () => {
    const allowed: Record<string, string[]> = {
      bitcoin: ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'],
      litecoin: ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh'],
      dogecoin: ['p2pkh'], dash: ['p2pkh'], bitcoincash: ['p2pkh'],
    }
    for (const [id, types] of Object.entries(allowed)) {
      for (const scriptType of ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr', 'p2wsh', '']) {
        const run = () => validateTxBuildRequest(req(id, { to: VALID_TO[id], scriptType }), CHAINS)
        if (types.includes(scriptType)) expect(run().request.scriptType).toBe(scriptType as any)
        else expect(code(run)).toBe('SCRIPT_TYPE_UNSUPPORTED')
      }
    }
    for (const id of ['cosmos', 'osmosis', 'thorchain', 'mayachain', 'ripple']) {
      expect(code(() => validateTxBuildRequest(req(id, { to: VALID_TO[id], scriptType: 'p2pkh' }), CHAINS))).toBe('SCRIPT_TYPE_UNSUPPORTED')
    }
    // Absent: today's behavior, and the builder request carries no scriptType key.
    expect('scriptType' in validateTxBuildRequest(req('litecoin', { to: VALID_TO.litecoin }), CHAINS).request).toBe(false)
  })
})

describe('txBuildAccountPath', () => {
  const H = 0x80000000
  test('the purpose-matched account path Desktop derives, for any account index', () => {
    expect(txBuildAccountPath(chain('litecoin'), 'p2wpkh', 1)).toEqual([H + 84, H + 2, H + 1])
    expect(txBuildAccountPath(chain('litecoin'), 'p2pkh', 0)).toEqual([H + 44, H + 2, H])
    expect(txBuildAccountPath(chain('litecoin'), 'p2sh-p2wpkh', 4)).toEqual([H + 49, H + 2, H + 4])
    expect(txBuildAccountPath(chain('bitcoin'), 'p2tr', 2)).toEqual([H + 86, H, H + 2])
    expect(txBuildAccountPath(chain('dogecoin'), 'p2pkh', 3)).toEqual([H + 44, H + 3, H + 3])
    expect(txBuildAccountPath(chain('bitcoincash'), 'p2pkh', 0)).toEqual([H + 44, H + 145, H])
    expect(txBuildAccountPath(chain('dash'), 'p2pkh', 1)).toEqual([H + 44, H + 5, H + 1])
  })

  test('types Desktop does not spend on that chain have no path', () => {
    expect(txBuildAccountPath(chain('litecoin'), 'p2tr', 0)).toBeUndefined()
    expect(txBuildAccountPath(chain('dogecoin'), 'p2wpkh', 0)).toBeUndefined()
    expect(txBuildAccountPath(chain('cosmos'), 'p2pkh', 0)).toBeUndefined()
  })
})

describe('btcXpubForAccount', () => {
  const xp = (accountIndex: number, scriptType: any, purpose: number) => ({
    scriptType, purpose, path: [0x80000000 + purpose, 0x80000000, 0x80000000 + accountIndex],
    xpub: `xpub-${accountIndex}-${scriptType}`, xpubPrefix: 'xpub' as const, balance: '0', balanceUsd: 0,
  })
  const set = (selected?: BtcAccountSet['selectedXpub']): BtcAccountSet => ({
    accounts: [0, 1].map(i => ({ accountIndex: i, xpubs: [xp(i, 'p2pkh', 44), xp(i, 'p2wpkh', 84)], totalBalanceUsd: 0 })),
    totalBalanceUsd: 0, totalBalance: '0', ...(selected ? { selectedXpub: selected } : {}),
  })

  test('no script type: account N with the script type Desktop has selected', () => {
    expect(btcXpubForAccount(set({ accountIndex: 0, scriptType: 'p2pkh' }), 1).xpub).toBe('xpub-1-p2pkh')
    expect(btcXpubForAccount(set(), 1).xpub).toBe('xpub-1-p2wpkh')
  })

  test('a named script type wins over the one Desktop has selected', () => {
    expect(btcXpubForAccount(set({ accountIndex: 0, scriptType: 'p2pkh' }), 1, 'p2wpkh').xpub).toBe('xpub-1-p2wpkh')
    expect(btcXpubForAccount(set({ accountIndex: 1, scriptType: 'p2wpkh' }), 0, 'p2pkh').xpub).toBe('xpub-0-p2pkh')
  })

  test('a missing account is 400 ACCOUNT_NOT_FOUND', () => {
    expect(code(() => btcXpubForAccount(set(), 5))).toBe('ACCOUNT_NOT_FOUND')
    expect(code(() => btcXpubForAccount(set(), 5, 'p2pkh'))).toBe('ACCOUNT_NOT_FOUND')
  })

  test('an account without that type (Taproot on firmware without it) is 400 SCRIPT_TYPE_UNSUPPORTED', () => {
    expect(code(() => btcXpubForAccount(set(), 1, 'p2tr'))).toBe('SCRIPT_TYPE_UNSUPPORTED')
  })
})
