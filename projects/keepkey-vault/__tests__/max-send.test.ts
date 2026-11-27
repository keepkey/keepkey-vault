import { describe, expect, test } from 'bun:test'
import {
  baseUnitsToDecimalString,
  decimalToBaseUnits,
  nativeMaxSpendableAmount,
  normalizeDecimals,
  tokenMaxPrecisionReserveUnits,
  tokenMaxSpendableAmount,
  tokenMaxSpendableBaseUnits,
  tonMaxSpendableNano,
} from '../src/shared/max-send'

describe('token max send precision reserve', () => {
  test('reserves one displayed 8-decimal quantum for 18-decimal tokens', () => {
    expect(tokenMaxPrecisionReserveUnits(18)).toBe(10_000_000_000n)
    expect(tokenMaxSpendableAmount('27.49591932', 18)).toBe('27.49591931')
    expect(tokenMaxSpendableBaseUnits('27.49591932', 18)).toBe(27_495_919_310_000_000_000n)
  })

  test('reserves nothing for tokens with 8 decimals or fewer (KEEPKEY-92)', () => {
    expect(tokenMaxPrecisionReserveUnits(6)).toBe(0n)
    expect(tokenMaxSpendableAmount('27.495919', 6)).toBe('27.495919')
    expect(tokenMaxPrecisionReserveUnits(8)).toBe(0n)
    expect(tokenMaxSpendableAmount('27.49591932', 8)).toBe('27.49591932')
    expect(tokenMaxPrecisionReserveUnits(9)).toBe(10n)
  })

  test('does not reserve a whole zero-decimal token', () => {
    expect(tokenMaxPrecisionReserveUnits(0)).toBe(0n)
    expect(tokenMaxSpendableAmount('1', 0)).toBe('1')
  })

  test('floors decimal parsing to token precision', () => {
    expect(decimalToBaseUnits('1.123456789', 6)).toBe(1_123_456n)
  })

  test('accepts numeric-string token decimals from token metadata', () => {
    expect(normalizeDecimals('18')).toBe(18)
    expect(tokenMaxSpendableAmount('27.49591932', '18')).toBe('27.49591931')
  })

  test('does not run BigInt exponent math for invalid decimals', () => {
    expect(normalizeDecimals(undefined)).toBeNull()
    expect(decimalToBaseUnits('1.23', undefined)).toBeNull()
    expect(baseUnitsToDecimalString(123n, undefined)).toBe('123')
    expect(tokenMaxSpendableAmount('1.23', undefined)).toBe('1.23')
  })

  test('returns zero when the balance cannot cover the reserve', () => {
    expect(tokenMaxSpendableAmount('0.000000001', 18)).toBe('0')
  })
})

describe('native max send fee reserve', () => {
  test('subtracts reserve in base units without rounding SOL upward', () => {
    expect(nativeMaxSpendableAmount('0.100000006', 9, '0.000005')).toBe('0.099995006')
  })

  test('returns zero when native balance cannot cover reserve', () => {
    expect(nativeMaxSpendableAmount('0.000004999', 9, '0.000005')).toBe('0')
  })

  test('leaves native max unchanged when decimals are malformed', () => {
    expect(nativeMaxSpendableAmount('1.23', undefined, '0.01')).toBe('1.23')
  })
})

describe('TON max send (KEEPKEY-76)', () => {
  test('sends the live balance minus the 0.005 TON transfer reserve', () => {
    expect(tonMaxSpendableNano('1250000000', false)).toBe(1_245_000_000n)
  })
  test('keeps 0.01 TON back when the wallet deploys in the same message', () => {
    expect(tonMaxSpendableNano('1250000000', true)).toBe(1_240_000_000n)
  })
  test('refuses a balance that does not cover the reserve, or an unreadable one', () => {
    expect(tonMaxSpendableNano('5000000', false)).toBeNull()
    expect(tonMaxSpendableNano('9999999', true)).toBeNull()
    expect(tonMaxSpendableNano('', false)).toBeNull()
    expect(tonMaxSpendableNano('1.5', false)).toBeNull()
  })
})
