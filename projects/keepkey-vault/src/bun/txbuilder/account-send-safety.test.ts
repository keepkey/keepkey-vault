import { afterEach, describe, expect, test } from 'bun:test'
import { buildCosmosTx, buildCosmosStakingTx, buildCosmosNameRegTx } from './cosmos'
import { buildXrpTx } from './xrp'
import { confirmAccountTx } from './confirm-account-tx'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const chain = (id = 'cosmos', denom = 'uatom', decimals = 6) => ({ id, denom, decimals, symbol: 'ATOM', coin: 'Cosmos', chainId: 'cosmoshub-4', defaultPath: [], chainFamily: 'cosmos' }) as any
const pioneer = { GetAccountInfo: async () => ({ data: { account: { account_number: '1', sequence: '0' } } }) }
const send = (amount: string, extra = {}) => buildCosmosTx(pioneer, chain(), { to: 'cosmos1recipient', fromAddress: 'cosmos1sender', amount, feeLevel: 3, ...extra })
const balances = (coins: Record<string, string>) => {
  globalThis.fetch = (async () => Response.json({ balances: Object.entries(coins).map(([denom, amount]) => ({ denom, amount })) })) as typeof fetch
}

describe('account send affordability', () => {
  test('reported incident: 0.0075 ATOM cannot pay 0.001 plus a 0.0075 fee', async () => {
    balances({ uatom: '7500' })
    await expect(send('0.001')).rejects.toThrow(/Insufficient.*transaction fee/)
  })
  test('exact amount plus fee passes; one base unit over fails', async () => {
    balances({ uatom: '8500' })
    expect((await send('0.001')).tx.fee.amount[0].amount).toBe('7500')
    balances({ uatom: '8499' })
    await expect(send('0.001')).rejects.toThrow(/Insufficient/)
  })
  test('verified zero, malformed data, failures and incomplete pages never authorize a send', async () => {
    balances({})
    await expect(send('0.001')).rejects.toThrow(/Insufficient/)
    for (const body of [{}, { balances: [{ denom: 'uatom', amount: '-1' }] }, { balances: [], pagination: { next_key: 'more' } }]) {
      globalThis.fetch = (async () => Response.json(body)) as typeof fetch
      await expect(send('0.001')).rejects.toThrow(/Unable to verify/)
    }
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
    await expect(send('0.001')).rejects.toThrow(/Unable to verify/)
  })
  test('retries reads on another endpoint without accepting a cached figure', async () => {
    let calls = 0
    globalThis.fetch = (async () => ++calls === 1 ? new Response('', { status: 503 }) : Response.json({ balances: [{ denom: 'uatom', amount: '8500' }] })) as typeof fetch
    expect((await send('0.001')).fee).toBe('0.0075')
    expect(calls).toBe(2)
  })
  test('rejects invalid precision and negative amounts without truncation', async () => {
    balances({ uatom: '1000000' })
    for (const amount of ['-1', 'NaN', '1.0000001']) await expect(send(amount)).rejects.toThrow()
  })
  test('RUNE and CACAO require the bank fee even though auth fee is zero', async () => {
    for (const [id, denom, decimals, fee] of [['thorchain', 'rune', 8, 2000000n], ['mayachain', 'cacao', 10, 2000000000n]] as const) {
      balances({ [denom]: String(fee) })
      await expect(buildCosmosTx(pioneer, chain(id, denom, decimals), { amount: '0.001', to: 'recipient', fromAddress: 'sender' })).rejects.toThrow(/Insufficient/)
    }
  })
  test('token sends require both live token principal and native fee', async () => {
    const token = { caip: 'cosmos:cosmoshub-4/denom:token', tokenDecimals: 6 }
    balances({ token: '1000000', uatom: '7499' })
    await expect(send('1', token)).rejects.toThrow(/transaction fee/)
    balances({ token: '999999', uatom: '7500' })
    await expect(send('1', token)).rejects.toThrow(/token balance/)
    balances({ token: '1000000', uatom: '7500' })
    expect((await send('1', token)).tx.msg[0].value.amount[0].denom).toBe('token')
  })
  test('staking reserves liquid fees; undelegation does not charge liquid principal', async () => {
    balances({ uatom: '6000' })
    const staking = { validatorAddress: 'validator', fromAddress: 'sender', amount: '1', type: 'delegate' as const }
    await expect(buildCosmosStakingTx(pioneer, chain(), staking)).rejects.toThrow(/Insufficient/)
    expect((await buildCosmosStakingTx(pioneer, chain(), { ...staking, type: 'undelegate' })).tx.msg[0].type).toBe('cosmos-sdk/MsgUndelegate')
    balances({ uatom: '4999' })
    await expect(buildCosmosStakingTx(pioneer, chain(), { ...staking, type: 'undelegate' })).rejects.toThrow(/Insufficient/)
  })
  test('name registration requires the deposit plus the native bank fee', async () => {
    balances({ rune: '10000000' })
    const p = { ...pioneer, GetNameRegistrationQuote: async () => ({ data: { registerFeeBase: '10000000', feePerBlockBase: '1', blocksPerYear: '1' } }) }
    await expect(buildCosmosNameRegTx(p, chain('thorchain', 'rune', 8), { name: 'test', years: 1, fromAddress: 'sender' })).rejects.toThrow(/Insufficient/)
  })
  test('XRP ordinary send preserves owner reserves and requires complete account data', async () => {
    globalThis.fetch = (async () => Response.json({ result: { state: { validated_ledger: { reserve_base: 1000000, reserve_inc: 200000 } } } })) as typeof fetch
    const p = (data: any) => ({ GetAccountInfo: async () => ({ data }) })
    const params = { amount: '3.4', to: 'rRecipient', fromAddress: 'rSender' }
    await expect(buildXrpTx(p({ Balance: '5000000', OwnerCount: 3 }), chain('ripple'), params)).rejects.toThrow(/reserve/)
    await expect(buildXrpTx(p({ OwnerCount: 0 }), chain('ripple'), params)).rejects.toThrow(/balance/)
    expect((await buildXrpTx(p({ Balance: '5000000', OwnerCount: 3 }), chain('ripple'), { ...params, amount: '3.399' })).payment.amount).toBe('3399000')
  })
})

describe('execution result, after broadcast acceptance', () => {
  const txid = 'A'.repeat(64)
  const check = (body: any, family = 'cosmos') => {
    globalThis.fetch = (async () => Response.json(body)) as typeof fetch
    return confirmAccountTx({ id: family === 'cosmos' ? 'cosmos' : 'ripple', chainFamily: family as any }, txid, { attempts: 1 })
  }
  test('ATOM included code 5 is failure, with fee warning and txid', async () => {
    await expect(check({ tx_response: { txhash: txid, height: '33895308', code: 5, raw_log: 'insufficient funds' } })).rejects.toThrow(/failed on chain.*insufficient funds.*fee/)
  })
  test('string chain codes are checked too', async () => {
    await expect(check({ tx_response: { txhash: txid, height: '33895308', code: '5' } })).rejects.toThrow(/failed on chain/)
  })
  test('only matching included code zero confirms a Cosmos send', async () => {
    await check({ tx_response: { txhash: txid, height: '33895308', code: 0 } })
    for (const tx of [{ txhash: txid, height: '0', code: 0 }, { txhash: 'B'.repeat(64), height: '1', code: 0 }, { txhash: txid, height: '1' }]) {
      await expect(check({ tx_response: tx })).rejects.toThrow(/confirmation is unknown/)
    }
  })
  test('pending or unreachable means unknown, never completed, and checks never POST a broadcast', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: any, options: any) => { calls++; expect(options.method).toBeUndefined(); return new Response('', { status: 404 }) }) as typeof fetch
    await expect(confirmAccountTx(chain(), txid, { attempts: 1 })).rejects.toThrow(txid)
    expect(calls).toBe(2)
  })
  test('XRP requires validation and checks final engine result', async () => {
    await expect(check({ result: { hash: txid, validated: true, meta: { TransactionResult: 'tecUNFUNDED_PAYMENT' } } }, 'xrp')).rejects.toThrow(/failed on chain/)
    await expect(check({ result: { hash: txid, validated: false, meta: { TransactionResult: 'tesSUCCESS' } } }, 'xrp')).rejects.toThrow(/confirmation is unknown/)
    await check({ result: { hash: txid, validated: true, meta: { TransactionResult: 'tesSUCCESS' } } }, 'xrp')
  })
})
