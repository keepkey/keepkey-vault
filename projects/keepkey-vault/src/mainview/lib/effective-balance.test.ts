import { expect, test } from 'bun:test'
import { ownerUsdAtAggregatePrice, selectedOwnerBalance } from './effective-balance'
import type { ChainBalance, EvmAddressChainBalance } from '../../shared/types'

const OWNER = '0x1111111111111111111111111111111111111111'
// Sidebar row: 0.001134 ETH at the refreshed price ($3000 → $3.402).
const agg: ChainBalance = { chainId: 'base', symbol: 'ETH', balance: '0.001134', balanceUsd: 3.402, nativeBalanceUsd: 3.402, address: OWNER, updatedAt: 1 }
const owner = (patch: Partial<EvmAddressChainBalance> = {}): EvmAddressChainBalance => ({
  chainId: 'base', symbol: 'ETH', balance: '0.001134', balanceUsd: 3.2, nativeBalanceUsd: 3.2, syncState: 'confirmed', ...patch })

test('the center card prices the owner at the sidebar price, not its own older price (audit v4 H18)', () => {
  const card = selectedOwnerBalance(agg, owner(), OWNER, true)!
  expect(card.nativeBalanceUsd).toBeCloseTo(3.402, 9)
  expect(card.balanceUsd).toBeCloseTo(3.402, 9)
  expect(card.balance).toBe('0.001134')
})

test('tokens keep their own USD; only the native part is repriced', () => {
  const card = selectedOwnerBalance(agg, owner({ balanceUsd: 13.2, nativeBalanceUsd: 3.2 }), OWNER, true)!
  expect(card.balanceUsd).toBeCloseTo(13.402, 9)
})

test('an owner figure the sidebar refused (stale or degraded) never makes the card disagree with it (audit v4 H3)', () => {
  for (const syncState of ['stale', 'degraded'] as const) {
    const card = selectedOwnerBalance(agg, owner({ balance: '0.001433', balanceUsd: 4.3, nativeBalanceUsd: 4.3, syncState }), OWNER, true)
    expect(card).toBe(agg)
  }
})

test('with several owners the card stays on the selected owner; without an aggregate it shows the owner as is', () => {
  const stale = owner({ balance: '0.5', balanceUsd: 1500, nativeBalanceUsd: 1500, syncState: 'stale' })
  expect(selectedOwnerBalance(agg, stale, OWNER, false)!.balance).toBe('0.5')
  expect(selectedOwnerBalance(undefined, owner(), OWNER, true)).toMatchObject({ balance: '0.001134', balanceUsd: 3.2, address: OWNER })
  expect(selectedOwnerBalance(agg, undefined, OWNER, true)).toBe(agg)
})

test('sidebar per-account rows and the chain page total use the sidebar price too (audit v4 H18)', () => {
  expect(ownerUsdAtAggregatePrice(agg, owner()).balanceUsd).toBeCloseTo(3.402, 9)
  expect(ownerUsdAtAggregatePrice(agg, owner({ balance: '0.002268', balanceUsd: 16.4, nativeBalanceUsd: 6.4 })).balanceUsd).toBeCloseTo(16.804, 9)
  // No aggregate price: the owner's own figure, never an invented one.
  expect(ownerUsdAtAggregatePrice(undefined, owner())).toEqual({ balanceUsd: 3.2, nativeBalanceUsd: 3.2 })
})
