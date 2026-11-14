import { describe, expect, test } from 'bun:test'
import {
  isPlaceholderOutboundTxHash,
  selectOutboundTxid,
  shouldRetryCompletedSwapMetadata,
  retainSwapProgress,
  settlementFromThornodeStatus,
} from '../src/shared/swap-tracker-guards'
import { advanceSwapStatus } from '../src/shared/relay-status'
import type { SwapTrackingStatus } from '../src/shared/types'

describe('swap progress never moves backward on stale data', () => {
  test('processing and payout stages survive older poll/push responses', () => {
    let status: SwapTrackingStatus = 'pending'
    const sequence: SwapTrackingStatus[] = ['confirming', 'pending', 'output_detected', 'confirming', 'output_confirmed', 'pending', 'completed', 'output_confirming']
    const seen = sequence.map(incoming => (status = advanceSwapStatus(status, incoming)))
    expect(seen).toEqual(['confirming', 'confirming', 'output_detected', 'output_detected', 'output_confirmed', 'output_confirmed', 'completed', 'completed'])
  })
  test('failure and refund remain explicit terminal outcomes', () => {
    expect(advanceSwapStatus('confirming', 'failed')).toBe('failed')
    expect(advanceSwapStatus('output_confirming', 'refunded')).toBe('refunded')
    expect(advanceSwapStatus('refunded', 'pending')).toBe('refunded')
    expect(advanceSwapStatus('completed', 'refunded')).toBe('refunded')
  })
  test('a confirmation disappearing does not erase a visited checkpoint', () => {
    let progress = { txid: 'first', step: 0 }
    const seen = [1, 0, 1, 2, 0, 3, 1].map(step => (progress = retainSwapProgress(progress, 'first', step)).step)
    expect(seen).toEqual([1, 1, 1, 2, 2, 3, 3])
    expect(retainSwapProgress(progress, 'second', 0)).toEqual({ txid: 'second', step: 0 })
    expect(retainSwapProgress(progress, null, 0)).toEqual({ txid: null, step: 0 })
  })
})

describe('outbound transaction guards', () => {
  test.each(['', '  ', '0x', '0X', '0', '0000', '0x0000', '0X0000', ' 0x0000 '])(
    'recognizes placeholder %p',
    (value) => expect(isPlaceholderOutboundTxHash(value)).toBe(true),
  )

  test('does not mistake a real transaction id for a placeholder', () => {
    expect(isPlaceholderOutboundTxHash('0xa806bffa')).toBe(false)
    expect(isPlaceholderOutboundTxHash('11111111111111111111111111111111')).toBe(false)
  })

  test('a real integration candidate wins over an earlier placeholder', () => {
    expect(selectOutboundTxid(['0x0000', undefined, ' 0xa806bffa '])).toEqual({
      outboundTxid: '0xa806bffa',
      placeholderOnly: false,
    })
  })

  test('reports placeholderOnly when no real candidate exists', () => {
    expect(selectOutboundTxid([undefined, '', '0X0000'])).toEqual({ placeholderOnly: true })
  })
})

describe('completed metadata retry guard', () => {
  test('retries only placeholder-completed swaps and stays bounded', () => {
    expect(shouldRetryCompletedSwapMetadata('completed', true, 0)).toBe(true)
    expect(shouldRetryCompletedSwapMetadata('completed', true, 5)).toBe(true)
    expect(shouldRetryCompletedSwapMetadata('completed', true, 6)).toBe(false)
    expect(shouldRetryCompletedSwapMetadata('completed', false, 0)).toBe(false)
    expect(shouldRetryCompletedSwapMetadata('confirming', true, 0)).toBe(false)
  })
})

// Audit v4 H8: THORNode lists the RUNE affiliate leg first with an all-zero id.
// Pioneer surfaces that placeholder as the outbound hash forever.
import thornodeStatus from './fixtures/thornode/rune-to-base-eth-status.json'
describe('THORNode status settles a swap whose first out_tx is the zero-id affiliate leg', () => {
  const dest = '0x73171652773bF2b8EB389eAF608125F98e90E0b7'
  test('picks the real outbound to the destination and reports completion', () => {
    expect(settlementFromThornodeStatus(thornodeStatus, dest)).toEqual({
      completed: true,
      outboundTxid: '7EFAF203DB9B91926B194116C2B1F0B91689D9AA8C9AFB5A700E5EDC7E1A963A',
      outboundAmount: '29880',
    })
  })
  test('not complete while the outbound is unsigned', () => {
    const pending = { ...thornodeStatus, stages: { ...thornodeStatus.stages, outbound_signed: { completed: false } }, out_txs: [thornodeStatus.out_txs[0]] }
    expect(settlementFromThornodeStatus(pending, dest).completed).toBe(false)
  })
  test('null on garbage', () => {
    expect(settlementFromThornodeStatus(null, dest).completed).toBe(false)
  })
})
