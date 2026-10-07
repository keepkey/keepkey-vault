import { expect, test } from 'bun:test'
import { isSwapFullySettled, payoutBelowMinimum } from '../src/shared/swap-settlement'

const payout = { txid: '0xabc', amount: '1.55' }

test('streaming swap stays incomplete while a partial payout is pending', () => {
  expect(isSwapFullySettled({ status: 'pending', integration: 'thorchain', payouts: [payout], receivedOutput: '1.55' })).toBe(false)
})

test('protocol amount remains in progress until all split payments pass the memo minimum', () => {
  expect(payoutBelowMinimum('216728726', '3.61863598')).toBe(true)
  expect(payoutBelowMinimum('371735433', '3.61863598')).toBe(false)
})

test('legacy completed row without settlement evidence cannot show Done', () => {
  expect(isSwapFullySettled({ status: 'completed', integration: 'thorchain', receivedOutput: '3.73055256' })).toBe(false)
})

test('a first payout below the memo minimum cannot show Done even if status says completed', () => {
  expect(isSwapFullySettled({ status: 'completed', integration: 'thorchain', payouts: [payout],
    receivedOutput: '2.16728726', minimumOutput: '3.61863598' })).toBe(false)
})

test('protocol completed with reported payout can show Done', () => {
  expect(isSwapFullySettled({ status: 'completed', integration: 'thorchain', payouts: [payout],
    receivedOutput: '3.71735433', minimumOutput: '3.61863598' })).toBe(true)
})

test('unrelated integration keeps its completion semantics', () => {
  expect(isSwapFullySettled({ status: 'completed', integration: 'relay' })).toBe(true)
})
