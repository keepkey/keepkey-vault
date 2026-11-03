import { expect, test } from 'bun:test'
import { shouldApplyOwnerBalanceSnapshot } from '../src/shared/evm-owner-balance'

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
