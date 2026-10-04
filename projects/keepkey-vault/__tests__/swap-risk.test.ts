import { describe, expect, test } from 'bun:test'
import { assessSwapRisk, thorMemoMinimum } from '../src/shared/swap-risk'

const assess = (value: number, expected = 99, minimum = 97) => assessSwapRisk({ inputAmount: 100, expectedAmount: expected, minimumAmount: minimum, fromPriceUsd: value / 100, toPriceUsd: 0, sameAssetUnits: true })

describe('trade value policy', () => {
  test('$1,000 refers to input trade value, not dollars lost', () => {
    expect(assess(999.99).tier).toBe('small')
    expect(assess(999.99).requiresAcknowledgment).toBe(false)
    expect(assess(1000).tier).toBe('large')
    expect(assess(1000).requiresAcknowledgment).toBe(true)
    expect(assess(1000).expectedLossUsd).toBeCloseTo(10)
  })
  test('large trade threshold boundaries', () => {
    expect(assess(1000, 99.51, 99).warning).toBe(false)
    expect(assess(1000, 99.5, 99).warning).toBe(true)
    expect(assess(1000, 99.5, 98).requiresAcknowledgment).toBe(true)
    expect(assess(1000, 99, 99).requiresAcknowledgment).toBe(true)
    expect(assess(1000, 95.01, 94).blocked).toBe(false)
    expect(assess(1000, 95, 94).blocked).toBe(true)
    expect(assess(999.99, 95, 94).blocked).toBe(false)
  })
  test('unavailable prices are never classified as a small safe trade', () => {
    const risk = assessSwapRisk({ inputAmount: 100, expectedAmount: 1, minimumAmount: 0.9, fromPriceUsd: 0, toPriceUsd: 0, sameAssetUnits: false })
    expect(risk.tier).toBe('unknown')
    expect(risk.requiresAcknowledgment).toBe(true)
    expect(risk.expectedLossPct).toBeUndefined()
  })
  test('the incident memo permits 3.528% input-value loss, distinct from actual output loss', () => {
    const minimumAmount = thorMemoMinimum('=:BASE.ETH:0x27de622cc44c55b53caF299eCedccdAB29aC98A8:361863598:keep:30')!
    expect(minimumAmount).toBe(3.61863598)
    const risk = assessSwapRisk({ inputAmount: 3.75096577, expectedAmount: 3.71735433, minimumAmount, fromPriceUsd: 2705.61, toPriceUsd: 0, sameAssetUnits: true })
    expect(risk.expectedLossPct).toBeCloseTo(0.89607429)
    expect(risk.minimumLossPct).toBeCloseTo(3.52788583)
    expect(risk.requiresAcknowledgment).toBe(true)
    expect(risk.blocked).toBe(false)
  })
  test('reads scientific/streaming limits without treating other memos as limits', () => {
    expect(thorMemoMinimum('=:ETH.ETH:dest:1e8/3/0:keep:30')).toBe(1)
    expect(thorMemoMinimum('=:ETH.ETH:dest::keep:30')).toBe(0)
    expect(thorMemoMinimum('=:ETH.ETH:dest:NaN')).toBeUndefined()
    expect(thorMemoMinimum('cf:swap')).toBeUndefined()
    expect(thorMemoMinimum('=:ETH.ETH:dest:1e8:keep:30:aggregator')).toBeUndefined()
  })
})
