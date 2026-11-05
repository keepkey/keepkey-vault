import { afterEach, describe, expect, test } from 'bun:test'
import { CHAINS } from '../../shared/chains'
import { buildXrpTx, getXrpMaxAmount } from './xrp'
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const pioneer = {
  GetAccountInfo: async () => ({ data: { Sequence: 7, ledger_index_current: 900, Balance: '5000000' } }),
}

describe('XRP transaction builder', () => {
  test('MAX reserves the entire signed fee and the live owner reserve in exact drops', async () => {
    globalThis.fetch = (async () => Response.json({ result: { state: { validated_ledger: { reserve_base: 1000000, reserve_inc: 200000 } } } })) as unknown as typeof fetch
    const p = { GetAccountInfo: async () => ({ data: { Sequence: 7, ledger_index_current: 900, Balance: '5000000', OwnerCount: 3 } }) }
    const tx = await buildXrpTx(p, CHAINS.find(c => c.id === 'ripple')!, { to: 'rRecipient', amount: '5', fromAddress: 'rSender', isMax: true })
    expect(tx.payment.amount).toBe('3399000')
    expect(tx.tx.value.fee.amount[0].amount).toBe('1000')
    expect(await getXrpMaxAmount(p, 'rSender')).toBe('3.399000')
  })
  test('MAX never guesses when live reserves or owner count are missing', async () => {
    globalThis.fetch = (async () => Response.json({ result: {} })) as unknown as typeof fetch
    const p = { GetAccountInfo: async () => ({ data: { Balance: '5000000', OwnerCount: 0 } }) }
    await expect(getXrpMaxAmount(p, 'rSender')).rejects.toThrow(/Cannot verify XRP account reserves/)
    await expect(getXrpMaxAmount(pioneer, 'rSender')).rejects.toThrow(/owner count/)
  })
  test('MAX does not round a balance larger than Number.MAX_SAFE_INTEGER', async () => {
    globalThis.fetch = (async () => Response.json({ result: { state: { validated_ledger: { reserve_base: 1000000, reserve_inc: 200000 } } } })) as unknown as typeof fetch
    const p = { GetAccountInfo: async () => ({ data: { Balance: '9007199254740993', OwnerCount: 0 } }) }
    expect(await getXrpMaxAmount(p, 'rSender')).toBe('9007199253.739993')
  })
  test('invalid precision and insufficient fee balance fail before signing', async () => {
    const chain = CHAINS.find(c => c.id === 'ripple')!
    for (const amount of ['1.0000001', 'NaN', 'Infinity', '-1', '1garbage']) {
      await expect(buildXrpTx(pioneer, chain, { to: 'rRecipient', amount, fromAddress: 'rSender' })).rejects.toThrow(/Invalid XRP amount/)
    }
    await expect(buildXrpTx(pioneer, chain, { to: 'rRecipient', amount: '5', fromAddress: 'rSender' })).rejects.toThrow(/transaction fee/)
  })
  test('forwards a THORChain routing memo to the 7.15 RippleSignTx adapter', async () => {
    const chain = CHAINS.find((candidate) => candidate.id === 'ripple')!
    const tx = await buildXrpTx(pioneer, chain, {
      to: 'rInboundVault', amount: '1', fromAddress: 'rSender', memo: '=:ETH.ETH:0x1234',
    })
    expect(tx.tx.value.memo).toBe('=:ETH.ETH:0x1234')
    expect(tx.payment.destinationTag).toBe('0')
  })

  test('continues to support numeric destination tags', async () => {
    const chain = CHAINS.find((candidate) => candidate.id === 'ripple')!
    const tx = await buildXrpTx(pioneer, chain, {
      to: 'rRecipient', amount: '1', fromAddress: 'rSender', memo: '12345',
    })
    expect(tx.payment.destinationTag).toBe('12345')
    expect(tx.tx.value.memo).toBe(' ')
  })
})
