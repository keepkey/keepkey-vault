import { describe, expect, test } from 'bun:test'
import { buildCosmosTx } from '../src/bun/txbuilder/cosmos'
import { CHAINS } from '../src/shared/chains'

const maya = CHAINS.find(c => c.id === 'mayachain')!
const thor = CHAINS.find(c => c.id === 'thorchain')!

// maya13d4… from the failed swap report: a MAX CACAO→ETH MsgDeposit that swept
// 100% of the balance and reverted with "insufficient funds" because nothing
// was left for MAYAChain's 0.2 CACAO NativeTransactionFee.
const mayaAddress = 'maya13d4tzmehhmt4r8w9s4n0g0lw7h3ggpyv95f55k'
const thorAddress = 'thor1qg5lz2j4xqy2k0n4h8p9d7v3c6m8t0r5w2e1a3'

function mockPioneer(balance: string) {
  return {
    GetAccountInfo: async () => ({
      data: { account: { account_number: '123', sequence: '4' } },
    }),
    GetPortfolioBalances: async () => ({
      data: { balances: [{ balance }] },
    }),
  }
}

describe('Cosmos MAX send/deposit fee reserve', () => {
  // CACAO has 10 decimals; balance from the failing tx was 7782513301100 base
  // units (778.25133011 CACAO). A correct MAX must reserve 0.2 CACAO
  // (2000000000 base) so the account has amount + fee on hand.
  test('mayachain MsgDeposit MAX reserves the 0.2 CACAO native fee', async () => {
    expect(maya.decimals).toBe(10)

    const result = await buildCosmosTx(mockPioneer('778.25133011'), maya, {
      to: mayaAddress,
      amount: '0',
      memo: '=:ETH.ETH:0x9f5f2e605863dc1D9CCB98BC104E10fD551d8eE9',
      isMax: true,
      isSwapDeposit: true,
      fromAddress: mayaAddress,
    })

    const msg = result.tx.msg[0] as any
    expect(msg.type).toBe('mayachain/MsgDeposit')
    // 7782513301100 balance − 2000000000 fee = 7780513301100
    expect(msg.value.coins[0].amount).toBe('7780513301100')
    expect(BigInt(msg.value.coins[0].amount)).toBeLessThan(7782513301100n)
  })

  test('mayachain MsgSend MAX also reserves the native fee', async () => {
    const result = await buildCosmosTx(mockPioneer('778.25133011'), maya, {
      to: mayaAddress,
      amount: '0',
      isMax: true,
      fromAddress: mayaAddress,
    })

    const msg = result.tx.msg[0] as any
    expect(msg.type).toBe('mayachain/MsgSend')
    expect(msg.value.amount[0].amount).toBe('7780513301100')
  })

  test('thorchain MAX still reserves 0.02 RUNE', async () => {
    // RUNE has 8 decimals: 10.0 RUNE = 1000000000 base, reserve 0.02 = 2000000.
    const result = await buildCosmosTx(mockPioneer('10.0'), thor, {
      to: thorAddress,
      amount: '0',
      isMax: true,
      isSwapDeposit: true,
      fromAddress: thorAddress,
    })

    const msg = result.tx.msg[0] as any
    expect(msg.type).toBe('thorchain/MsgDeposit')
    expect(msg.value.coins[0].amount).toBe('998000000')
  })
})
