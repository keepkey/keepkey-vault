import { expect, test } from 'bun:test'
import { selectedOwnerBalance } from './effective-balance'
import type { ChainBalance, EvmAddressChainBalance } from '../../shared/types'

const OWNER = '0x1111111111111111111111111111111111111111'
// Sidebar row: 0.001134 ETH at the refreshed price ($3000 → $3.402).
const agg: ChainBalance = { chainId: 'base', symbol: 'ETH', balance: '0.001134', balanceUsd: 3.402, nativeBalanceUsd: 3.402, address: OWNER, updatedAt: 1 }
const owner = (patch: Partial<EvmAddressChainBalance> = {}): EvmAddressChainBalance => ({
  chainId: 'base', symbol: 'ETH', balance: '0.001134', balanceUsd: 3.2, nativeBalanceUsd: 3.2, syncState: 'confirmed', ...patch })

test('the center card prices the owner at the sidebar price, not its own older price (audit v4 H18)', () => {
  const card = selectedOwnerBalance(agg, owner(), OWNER)!
  expect(card.nativeBalanceUsd).toBeCloseTo(3.402, 9)
  expect(card.balanceUsd).toBeCloseTo(3.402, 9)
  expect(card.balance).toBe('0.001134')
})

test('tokens keep their own USD; only the native part is repriced', () => {
  const card = selectedOwnerBalance(agg, owner({ balanceUsd: 13.2, nativeBalanceUsd: 3.2 }), OWNER)!
  expect(card.balanceUsd).toBeCloseTo(13.402, 9)
})

test('without an aggregate the card shows the owner as is; without an owner figure, the aggregate', () => {
  expect(selectedOwnerBalance(undefined, owner(), OWNER)).toMatchObject({ balance: '0.001134', balanceUsd: 3.2, address: OWNER })
  expect(selectedOwnerBalance(agg, undefined, OWNER)).toBe(agg)
})
