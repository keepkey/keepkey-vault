import { describe, expect, test } from 'bun:test'
import { CHAINS } from '../../shared/chains'
import { buildXrpTx } from './xrp'

const pioneer = {
  GetAccountInfo: async () => ({ data: { Sequence: 7, ledger_index_current: 900, Balance: '5000000' } }),
}

describe('XRP transaction builder', () => {
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
