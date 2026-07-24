import { describe, expect, test } from 'bun:test'
import type { ChainBalance, PendingSwap } from '../src/shared/types'
import {
  balanceAmountForAsset,
  beginSwapBalanceReconciliation,
  completeSwapBalanceReconciliation,
  mergeTrustedBalanceSnapshot,
  observeBalanceRefresh,
  protectedBalanceChainIds,
  shouldReplaceBalanceSnapshot,
} from '../src/shared/balance-reconciliation'

const SOL_USDT = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

function solanaBalance(usdt?: string, syncState: ChainBalance['syncState'] = 'confirmed'): ChainBalance {
  return {
    chainId: 'solana',
    symbol: 'SOL',
    balance: '2.5',
    balanceUsd: 500,
    address: 'wallet',
    syncState,
    tokens: usdt === undefined ? undefined : [{
      symbol: 'USDT',
      name: 'Tether',
      balance: usdt,
      balanceUsd: Number(usdt),
      priceUsd: 1,
      caip: SOL_USDT,
    }],
  }
}

describe('post-swap balance reconciliation', () => {
  test('protects a same-chain snapshot while SPL output is still missing', () => {
    const before = new Map([['solana', solanaBalance()]])
    const record = beginSwapBalanceReconciliation({
      txid: 'tx1',
      fromChainId: 'solana',
      toChainId: 'solana',
      fromCaip: 'solana:mainnet/slip44:501',
      toCaip: SOL_USDT,
      fromSymbol: 'SOL',
      toSymbol: 'USDT',
      expectedOutput: '10',
    }, before, 100)

    expect(record).not.toBeNull()
    const waiting = observeBalanceRefresh([record!], [solanaBalance()])
    expect(waiting).toHaveLength(1)
    expect(waiting[0].observed).toBe(false)
    expect(protectedBalanceChainIds(waiting).has('solana')).toBe(true)
  })

  test('does not trust a stale response even when it contains a higher amount', () => {
    const before = new Map([['solana', solanaBalance('4')]])
    const record = beginSwapBalanceReconciliation({
      txid: 'tx2',
      fromChainId: 'solana',
      toChainId: 'solana',
      toCaip: SOL_USDT,
      fromSymbol: 'SOL',
      toSymbol: 'USDT',
    }, before)!

    const waiting = observeBalanceRefresh([record], [solanaBalance('14', 'stale')])
    expect(waiting[0].observed).toBe(false)
  })

  test('accepts a stale portfolio row when the target asset was verified directly', () => {
    const before = new Map([['solana', solanaBalance('4')]])
    const record = beginSwapBalanceReconciliation({
      txid: 'tx-direct',
      fromChainId: 'solana',
      toChainId: 'solana',
      toCaip: SOL_USDT,
      fromSymbol: 'SOL',
      toSymbol: 'USDT',
    }, before)!
    const direct = solanaBalance('14', 'stale')
    direct.confirmedAssetCaips = [SOL_USDT]

    const observed = observeBalanceRefresh([record], [direct])
    expect(observed[0].observed).toBe(true)
    expect(protectedBalanceChainIds(observed).has('solana')).toBe(false)
  })

  test('releases the protected chain after a confirmed token increase', () => {
    const before = new Map([['solana', solanaBalance('4')]])
    const pending = beginSwapBalanceReconciliation({
      txid: 'tx3',
      fromChainId: 'solana',
      toChainId: 'solana',
      toCaip: SOL_USDT,
      fromSymbol: 'SOL',
      toSymbol: 'USDT',
    }, before)!
    const observed = observeBalanceRefresh([pending], [solanaBalance('14')])

    expect(observed[0].observed).toBe(true)
    expect(protectedBalanceChainIds(observed).has('solana')).toBe(false)

    const completed = completeSwapBalanceReconciliation(observed[0], {
      txid: 'tx3',
      fromAsset: 'SOL.SOL',
      toAsset: 'SOL.USDT',
      fromSymbol: 'SOL',
      toSymbol: 'USDT',
      fromChainId: 'solana',
      toChainId: 'solana',
      toCaip: SOL_USDT,
      fromAmount: '0.1',
      expectedOutput: '10',
      memo: '',
      inboundAddress: '',
      integration: 'nearIntents',
      status: 'completed',
      confirmations: 1,
      createdAt: 1,
      updatedAt: 2,
      estimatedTime: 30,
    } satisfies PendingSwap, new Map([['solana', solanaBalance('14')]]), 200)

    expect(observeBalanceRefresh([completed], [solanaBalance('14')])).toHaveLength(0)
  })

  test('reads native and token amounts independently', () => {
    const balance = solanaBalance('9.25')
    expect(balanceAmountForAsset(balance, SOL_USDT)).toBe(9.25)
    expect(balanceAmountForAsset(balance, 'solana:mainnet/slip44:501')).toBe(2.5)
  })

  test('never replaces a trusted snapshot with stale, degraded, or protected data', () => {
    const trusted = solanaBalance('10')
    expect(shouldReplaceBalanceSnapshot(trusted, solanaBalance(undefined, 'stale'), false)).toBe(false)
    expect(shouldReplaceBalanceSnapshot(trusted, solanaBalance(undefined, 'degraded'), false)).toBe(false)
    expect(shouldReplaceBalanceSnapshot(trusted, solanaBalance('11'), true)).toBe(false)
    expect(shouldReplaceBalanceSnapshot(trusted, solanaBalance('11'), false)).toBe(true)
    expect(shouldReplaceBalanceSnapshot(undefined, solanaBalance(undefined, 'degraded'), false)).toBe(true)
  })

  test('merges only a directly confirmed token from an otherwise stale chain row', () => {
    const trusted = solanaBalance()
    trusted.tokens = [{
      symbol: 'BONK',
      name: 'Bonk',
      balance: '5',
      balanceUsd: 2,
      priceUsd: 0.4,
      caip: 'solana:main/token:bonk',
    }]
    trusted.balanceUsd = 502
    const stale = solanaBalance('14', 'stale')
    stale.balance = '0'
    stale.balanceUsd = 14
    stale.confirmedAssetCaips = [SOL_USDT]

    const merged = mergeTrustedBalanceSnapshot(trusted, stale, false)!
    expect(merged.balance).toBe('2.5')
    expect(merged.balanceUsd).toBe(516)
    expect(merged.tokens?.map(token => token.symbol)).toEqual(['BONK', 'USDT'])
  })
})
