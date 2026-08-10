import { describe, expect, test } from 'bun:test'
import {
  isPlaceholderOutboundTxHash,
  selectOutboundTxid,
  shouldRetryCompletedSwapMetadata,
} from '../src/shared/swap-tracker-guards'

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
