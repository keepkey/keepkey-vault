import { describe, expect, test } from 'bun:test'
import { parseUnits, checkCustomGasPrice } from './evm'

describe('parseUnits', () => {
  test('rejects more decimals than the asset has (H6)', () => {
    expect(() => parseUnits('0.0000000000000000001', 18)).toThrow(/decimal/)
  })
  test('exact decimals still parse', () => {
    expect(parseUnits('0.000000000000000001', 18)).toBe(1n)
    expect(parseUnits('1.5', 6)).toBe(1_500_000n)
  })
})

describe('checkCustomGasPrice (H1)', () => {
  const net = 6_000_000n // 0.006 gwei, Base
  test('20 gwei on Base is refused', () => expect(() => checkCustomGasPrice(20_000_000_000n, net)).toThrow(/10x/))
  test('0.000001 gwei is refused', () => expect(() => checkCustomGasPrice(1_000n, net)).toThrow(/base fee/))
  test('2x network is allowed', () => expect(() => checkCustomGasPrice(net * 2n, net)).not.toThrow())
})
