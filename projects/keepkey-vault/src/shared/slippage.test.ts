import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  normalizeSlippageBps,
  parseCustomSlippagePercent,
  PERSIST_MAX_SLIPPAGE_BPS,
  CONFIRM_SLIPPAGE_BPS,
  SLIPPAGE_PRESETS_BPS,
  slippageAfterSwap,
} from './slippage'

describe('slippage policy', () => {
  test('normalizes basis points into the supported range', () => {
    expect(normalizeSlippageBps(undefined)).toBe(DEFAULT_SLIPPAGE_BPS)
    expect(normalizeSlippageBps(421)).toBe(421)
    expect(normalizeSlippageBps(0)).toBe(MIN_SLIPPAGE_BPS)
    expect(normalizeSlippageBps(9000)).toBe(MAX_SLIPPAGE_BPS)
  })

  test('accepts a custom value above the 3% preset', () => {
    expect(parseCustomSlippagePercent('4.5')).toEqual({ ok: true, bps: 450 })
    expect(parseCustomSlippagePercent('50')).toEqual({ ok: true, bps: 5000 })
  })

  test('rejects blank, non-numeric, and out-of-range percentages', () => {
    expect(parseCustomSlippagePercent('').ok).toBe(false)
    expect(parseCustomSlippagePercent('not-a-number').ok).toBe(false)
    expect(parseCustomSlippagePercent('0').ok).toBe(false)
    expect(parseCustomSlippagePercent('50.01').ok).toBe(false)
  })
})

describe('slippage memory (audit v4 V1)', () => {
  test('only tolerances up to 3% are remembered, and a confirmation is needed above 5%', () => {
    expect(PERSIST_MAX_SLIPPAGE_BPS).toBe(300)
    expect(CONFIRM_SLIPPAGE_BPS).toBe(500)
  })

  test('a preset survives a swap; a custom tolerance returns to the default', () => {
    for (const preset of SLIPPAGE_PRESETS_BPS) expect(slippageAfterSwap(preset)).toBe(preset)
    expect(slippageAfterSwap(250)).toBe(DEFAULT_SLIPPAGE_BPS)
    expect(slippageAfterSwap(3000)).toBe(DEFAULT_SLIPPAGE_BPS)
  })
})
