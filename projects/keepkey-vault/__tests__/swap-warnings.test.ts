/**
 * Tests for the pure swap-warning helpers in src/shared/swap-warnings.ts.
 *
 * These warnings drive UI surfacing decisions that we got wrong before:
 *   - dust-fee tier (>10% / >25% loss) — needs concrete examples to lock in
 *   - high-slippage check used to read only the quote's market slippage,
 *     missing the user's tolerance (so 5% tolerance + 0.2% market = silent risk)
 *
 * Run: bun test __tests__/swap-warnings.test.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  computeDustWarning,
  computeEffectiveSlippageBps,
  shouldWarnHighSlippage,
  DUST_FEE_WARNING_PCT,
  DUST_FEE_SEVERE_PCT,
  HIGH_SLIPPAGE_PCT,
} from '../src/shared/swap-warnings'

describe('computeDustWarning', () => {
  test('profitable swap (loss < threshold) → null', () => {
    // 100 USD in, 96 USD out → 4% loss, below 10% threshold
    const w = computeDustWarning({ inAmount: 100, outAmount: 96, fromPriceUsd: 1, toPriceUsd: 1 })
    expect(w).toBeNull()
  })

  test('exactly at warning threshold → null (strict <)', () => {
    // Loss exactly DUST_FEE_WARNING_PCT must NOT fire — only >= threshold.
    // The implementation uses `< DUST_FEE_WARNING_PCT` for early-out, so
    // strictly equal slips through. Documents the boundary explicitly.
    const w = computeDustWarning({ inAmount: 100, outAmount: 90, fromPriceUsd: 1, toPriceUsd: 1 })
    expect(w).not.toBeNull()
    expect(w!.lossPct).toBeCloseTo(10, 6)
    expect(w!.severe).toBe(false)
  })

  test('mid-tier loss (~15%) → warning, not severe', () => {
    const w = computeDustWarning({ inAmount: 100, outAmount: 85, fromPriceUsd: 1, toPriceUsd: 1 })
    expect(w).not.toBeNull()
    expect(w!.severe).toBe(false)
    expect(w!.lossPct).toBeCloseTo(15, 6)
    expect(w!.lostUsd).toBeCloseTo(15, 6)
    expect(w!.inUsd).toBe(100)
    expect(w!.recommendedMinUsd).toBe(400) // ceil(100 * 4)
  })

  test('severe loss (>25%) → severe=true', () => {
    // The "$2 BTC swap" scenario from the production bug — 30% loss
    const w = computeDustWarning({ inAmount: 100, outAmount: 70, fromPriceUsd: 1, toPriceUsd: 1 })
    expect(w).not.toBeNull()
    expect(w!.severe).toBe(true)
    expect(w!.lossPct).toBeCloseTo(30, 6)
  })

  test('zero input USD → null (avoid divide-by-zero)', () => {
    const w = computeDustWarning({ inAmount: 0, outAmount: 0, fromPriceUsd: 50000, toPriceUsd: 1 })
    expect(w).toBeNull()
  })

  test('zero output USD → null (no quote yet, do not warn)', () => {
    const w = computeDustWarning({ inAmount: 1, outAmount: 0, fromPriceUsd: 50000, toPriceUsd: 1 })
    expect(w).toBeNull()
  })

  test('NaN inputs → null', () => {
    expect(computeDustWarning({ inAmount: NaN, outAmount: 1, fromPriceUsd: 1, toPriceUsd: 1 })).toBeNull()
    expect(computeDustWarning({ inAmount: 1, outAmount: NaN, fromPriceUsd: 1, toPriceUsd: 1 })).toBeNull()
    expect(computeDustWarning({ inAmount: 1, outAmount: 1, fromPriceUsd: NaN, toPriceUsd: 1 })).toBeNull()
    expect(computeDustWarning({ inAmount: 1, outAmount: 1, fromPriceUsd: 1, toPriceUsd: NaN })).toBeNull()
  })

  test('cross-asset prices: BTC → USDT dust scenario', () => {
    // 0.00003 BTC @ $60k = $1.80 input
    // 1.50 USDT @ $1 = $1.50 output → 16.7% loss → warning
    const w = computeDustWarning({ inAmount: 0.00003, outAmount: 1.50, fromPriceUsd: 60000, toPriceUsd: 1 })
    expect(w).not.toBeNull()
    expect(w!.severe).toBe(false)
    expect(w!.lossPct).toBeGreaterThan(15)
    expect(w!.lossPct).toBeLessThan(20)
  })

  test('thresholds match documented constants', () => {
    expect(DUST_FEE_WARNING_PCT).toBe(10)
    expect(DUST_FEE_SEVERE_PCT).toBe(25)
  })
})

describe('computeEffectiveSlippageBps', () => {
  test('returns the larger of quote vs user', () => {
    expect(computeEffectiveSlippageBps(20, 500)).toBe(500)
    expect(computeEffectiveSlippageBps(500, 20)).toBe(500)
  })

  test('equal values → that value', () => {
    expect(computeEffectiveSlippageBps(100, 100)).toBe(100)
  })

  test('clamps negatives to 0', () => {
    expect(computeEffectiveSlippageBps(-50, 100)).toBe(100)
    expect(computeEffectiveSlippageBps(50, -100)).toBe(50)
    expect(computeEffectiveSlippageBps(-50, -100)).toBe(0)
  })

  test('NaN treated as 0', () => {
    expect(computeEffectiveSlippageBps(NaN, 200)).toBe(200)
    expect(computeEffectiveSlippageBps(200, NaN)).toBe(200)
    expect(computeEffectiveSlippageBps(NaN, NaN)).toBe(0)
  })
})

describe('shouldWarnHighSlippage', () => {
  test('the bug we know exists: tight quote + loose user setting → warns', () => {
    // Pioneer reported 0.19% (19 bps) market slippage; user set 5% (500 bps) tolerance.
    // Old check (quote only) → false. New check (max) → true.
    expect(shouldWarnHighSlippage(19, 500)).toBe(true)
  })

  test('both low → no warning', () => {
    expect(shouldWarnHighSlippage(50, 100)).toBe(false) // 1%
  })

  test('quote alone above threshold → warns', () => {
    expect(shouldWarnHighSlippage(400, 100)).toBe(true) // 4% market quote
  })

  test('exactly at threshold → no warning (strictly greater)', () => {
    // 300 bps = 3.00% — boundary check. Implementation uses `> HIGH_SLIPPAGE_PCT`.
    expect(shouldWarnHighSlippage(300, 0)).toBe(false)
    expect(shouldWarnHighSlippage(0, 300)).toBe(false)
  })

  test('just above threshold → warns', () => {
    expect(shouldWarnHighSlippage(301, 0)).toBe(true)
    expect(shouldWarnHighSlippage(0, 301)).toBe(true)
  })

  test('threshold matches documented constant', () => {
    expect(HIGH_SLIPPAGE_PCT).toBe(3)
  })
})
