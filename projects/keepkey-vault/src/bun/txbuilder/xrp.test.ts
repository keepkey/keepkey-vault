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
    // A routing memo is not a destination tag: no tag is sent at all.
    expect('destinationTag' in tx.payment).toBe(false)
  })

  test('an empty or blank tag field sends NO destination tag (never a silent tag 0)', async () => {
    const chain = CHAINS.find((candidate) => candidate.id === 'ripple')!
    for (const memo of [undefined, '', '   ']) {
      const tx = await buildXrpTx(pioneer, chain, { to: 'rRecipient', amount: '1', fromAddress: 'rSender', memo })
      expect('destinationTag' in tx.payment).toBe(false)
      expect(tx.payment.destinationTag).toBeUndefined()
    }
  })

  test('a non-numeric tag is rejected before signing instead of becoming a memo plus tag 0', async () => {
    const chain = CHAINS.find((candidate) => candidate.id === 'ripple')!
    for (const memo of ['Tag: 104857', '104857abc', 'abc', '10 4857', '-5', '1.5']) {
      await expect(buildXrpTx(pioneer, chain, { to: 'rRecipient', amount: '1', fromAddress: 'rSender', memo }))
        .rejects.toThrow(/whole number/)
    }
  })

  test('THORChain long-form routing memos stay memos', async () => {
    const chain = CHAINS.find((candidate) => candidate.id === 'ripple')!
    for (const memo of ['SWAP:ETH.ETH:0x1234', 's:BTC.BTC:bc1q', 'a:XRP.XRP']) {
      const tx = await buildXrpTx(pioneer, chain, { to: 'rInboundVault', amount: '1', fromAddress: 'rSender', memo })
      expect(tx.tx.value.memo).toBe(memo)
      expect('destinationTag' in tx.payment).toBe(false)
    }
  })

  test('tag range: 0 and 4294967295 are valid, 4294967296 is rejected, padding is trimmed', async () => {
    const chain = CHAINS.find((candidate) => candidate.id === 'ripple')!
    const build = (memo: string) => buildXrpTx(pioneer, chain, { to: 'rRecipient', amount: '1', fromAddress: 'rSender', memo })
    expect((await build('0')).payment.destinationTag).toBe('0')
    expect((await build('4294967295')).payment.destinationTag).toBe('4294967295')
    expect((await build(' 104857 ')).payment.destinationTag).toBe('104857')
    await expect(build('4294967296')).rejects.toThrow(/0-4294967295/)
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
