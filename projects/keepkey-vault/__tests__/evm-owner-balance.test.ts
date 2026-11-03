import { expect, test } from 'bun:test'
import { OwnerBalanceWatermarks, resetOwnerChainBalances, shouldApplyOwnerBalanceSnapshot } from '../src/shared/evm-owner-balance'
import type { EvmAddressChainBalance } from '../src/shared/types'

test('a late pre-send bulk read cannot restore an old owner snapshot', () => {
  const postSend = { updatedAt: 200 }
  expect(shouldApplyOwnerBalanceSnapshot(postSend, { updatedAt: 100 })).toBe(false)
  expect(shouldApplyOwnerBalanceSnapshot(postSend, {})).toBe(false)
  expect(shouldApplyOwnerBalanceSnapshot(postSend, { updatedAt: 201 })).toBe(true)
  expect(shouldApplyOwnerBalanceSnapshot(postSend, { updatedAt: 200 })).toBe(true)
})

test('initial and legacy owner caches still accept their first live snapshot', () => {
  expect(shouldApplyOwnerBalanceSnapshot(undefined, { updatedAt: 100 })).toBe(true)
  expect(shouldApplyOwnerBalanceSnapshot({}, { updatedAt: 100 })).toBe(true)
  expect(shouldApplyOwnerBalanceSnapshot(undefined, {})).toBe(true)
})

test('a delayed old bulk reset and reply preserve newer owner balance data', () => {
  const reads = new OwnerBalanceWatermarks()
  const newer: EvmAddressChainBalance = { chainId: 'ethereum', symbol: 'ETH', balance: '2', balanceUsd: 6000,
    nativeBalanceUsd: 6000, updatedAt: 200, syncState: 'confirmed' }
  expect(reads.accept('0xOwner', 'ethereum', newer)).toBe(true)
  let cache = { ethereum: newer }
  reads.beginRead('0xOwner', undefined, 100)
  cache = resetOwnerChainBalances(cache, undefined, 100) as typeof cache
  expect(cache.ethereum.balance).toBe('2')
  expect(cache.ethereum).toBe(newer)
  if (reads.accept('0xOWNER', 'ethereum', { ...newer, updatedAt: 100 })) cache.ethereum = { ...newer, balance: '100' }
  expect(cache.ethereum.balance).toBe('2')
  reads.beginRead('0xOwner', 'ethereum', 300)
  cache = resetOwnerChainBalances(cache, 'ethereum', 300) as typeof cache
  expect(cache.ethereum).toBeUndefined()
  expect(reads.accept('0xOwner', 'ethereum', { updatedAt: 100 })).toBe(false)
  expect(reads.accept('0xOwner', 'ethereum', { updatedAt: 250 })).toBe(false)
  expect(reads.accept('0xOtherOwner', 'ethereum', { updatedAt: 100 })).toBe(true)
  expect(reads.accept('0xOwner', 'arbitrum', { updatedAt: 100 })).toBe(true)
  reads.beginRead('0xOwner', undefined, 400)
  expect(reads.accept('0xOwner', 'base', { updatedAt: 350 })).toBe(false)
  expect(reads.accept('0xOwner', 'base', { updatedAt: 450 })).toBe(true)
  reads.clear()
  expect(reads.accept('0xOwner', 'ethereum', { updatedAt: 100 })).toBe(true)
})
