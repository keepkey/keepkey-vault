import { describe, expect, test } from 'bun:test'
import {
  decimalToBaseUnits,
  tokenMaxPrecisionReserveUnits,
  tokenMaxSpendableAmount,
  tokenMaxSpendableBaseUnits,
} from '../src/shared/max-send'

describe('token max send precision reserve', () => {
  test('reserves one displayed 8-decimal quantum for 18-decimal tokens', () => {
    expect(tokenMaxPrecisionReserveUnits(18)).toBe(10_000_000_000n)
    expect(tokenMaxSpendableAmount('27.49591932', 18)).toBe('27.49591931')
    expect(tokenMaxSpendableBaseUnits('27.49591932', 18)).toBe(27_495_919_310_000_000_000n)
  })

  test('reserves one base unit for low-decimal tokens', () => {
    expect(tokenMaxPrecisionReserveUnits(6)).toBe(1n)
    expect(tokenMaxSpendableAmount('27.495919', 6)).toBe('27.495918')
  })

  test('floors decimal parsing to token precision', () => {
    expect(decimalToBaseUnits('1.123456789', 6)).toBe(1_123_456n)
  })

  test('returns zero when the balance cannot cover the reserve', () => {
    expect(tokenMaxSpendableAmount('0.000000001', 18)).toBe('0')
  })
})
