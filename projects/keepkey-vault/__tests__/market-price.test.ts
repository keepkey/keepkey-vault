import { describe, expect, test } from 'bun:test'
import { marketPriceUsd } from '../src/shared/market-price'

describe('marketPriceUsd', () => {
  test('reads the current Pioneer numeric-array response', () => {
    expect(marketPriceUsd({ data: [76096.6], success: true })).toBe(76096.6)
    expect(marketPriceUsd({ data: { data: [76096.6], success: true } })).toBe(76096.6)
  })

  test('keeps compatibility with object-shaped responses', () => {
    expect(marketPriceUsd({ data: [{ priceUsd: 70000 }] })).toBe(70000)
    expect(marketPriceUsd([{ price: '71000.25' }])).toBe(71000.25)
  })

  test('fails closed for invalid or non-positive quotes', () => {
    expect(marketPriceUsd({ data: [] })).toBe(0)
    expect(marketPriceUsd({ data: ['not-a-price'] })).toBe(0)
    expect(marketPriceUsd({ data: [-1] })).toBe(0)
  })
})
