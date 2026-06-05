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
  // CACAO has 10 decimals; the reported balance was 7782513301100 base units
  // (778.25133011 CACAO). Reserving the *bare* 0.2 CACAO fee (→ 7780513301100)
  // STILL reverted with "insufficient funds": Pioneer's reported balance was a
  // few hundred base units higher than the real on-chain balance, so amount +
  // fee overdrew. The reserve must leave headroom (2× the native fee), so the
  // MAX amount is strictly below balance − bareFee.
  const MAYA_BAL_BASE = 7782513301100n   // 778.25133011 CACAO @ 10 decimals
  const MAYA_FEE_BASE = 2000000000n      // 0.2 CACAO native fee
  const MAYA_MAX_AMOUNT = '7778513301100' // balance − 2×fee

  test('mayachain MsgDeposit MAX reserves more than the bare native fee', async () => {
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
    expect(msg.value.coins[0].amount).toBe(MAYA_MAX_AMOUNT)
    // The whole point of the fix: headroom beyond the bare fee, so a slightly
    // stale reported balance can't make amount + fee overdraw the real balance.
    expect(BigInt(msg.value.coins[0].amount)).toBeLessThan(MAYA_BAL_BASE - MAYA_FEE_BASE)
  })

  test('mayachain MsgSend MAX reserves the same buffered native fee', async () => {
    const result = await buildCosmosTx(mockPioneer('778.25133011'), maya, {
      to: mayaAddress,
      amount: '0',
      isMax: true,
      fromAddress: mayaAddress,
    })

    const msg = result.tx.msg[0] as any
    expect(msg.type).toBe('mayachain/MsgSend')
    expect(msg.value.amount[0].amount).toBe(MAYA_MAX_AMOUNT)
  })

  test('thorchain MAX reserves more than the bare 0.02 RUNE fee', async () => {
    // RUNE has 8 decimals: 10.0 RUNE = 1000000000 base, bare fee 0.02 = 2000000,
    // 2× reserve = 4000000 → MAX = 996000000.
    const result = await buildCosmosTx(mockPioneer('10.0'), thor, {
      to: thorAddress,
      amount: '0',
      isMax: true,
      isSwapDeposit: true,
      fromAddress: thorAddress,
    })

    const msg = result.tx.msg[0] as any
    expect(msg.type).toBe('thorchain/MsgDeposit')
    expect(msg.value.coins[0].amount).toBe('996000000')
    expect(BigInt(msg.value.coins[0].amount)).toBeLessThan(1000000000n - 2000000n)
  })

  test('cosmos ATOM MsgSend MAX reserves above the actual feeLevel-adjusted fee', async () => {
    const atom = CHAINS.find(c => c.id === 'cosmos')!
    expect(atom.decimals).toBe(6)
    // Regression: the default dispatcher path uses feeLevel 5, which doubles the
    // 5000 uatom template fee to 10000 uatom (the *actual* fee paid). Reserving
    // FEES.cosmos×2 (=10000) before that left amount + fee == balance exactly —
    // zero headroom. The reserve must sit above the adjusted fee. 1.0 ATOM =
    // 1000000 uatom; reserve max(10000,5000)×2 = 20000 → amount 980000.
    const result = await buildCosmosTx(mockPioneer('1.0'), atom, {
      to: 'cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      amount: '0',
      isMax: true,
      fromAddress: 'cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    })

    const msg = result.tx.msg[0] as any
    expect(msg.type).toBe('cosmos-sdk/MsgSend')
    const amount = BigInt(msg.value.amount[0].amount)
    const adjustedFee = BigInt(result.tx.fee.amount[0].amount)
    expect(adjustedFee).toBe(10000n)            // feeLevel 5 → 2× the 5000 template
    expect(amount).toBe(980000n)
    // The fix: amount + the fee it will actually pay stays strictly under balance.
    expect(amount + adjustedFee).toBeLessThan(1000000n)
  })
})
