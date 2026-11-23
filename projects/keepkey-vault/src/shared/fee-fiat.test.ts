import { describe, expect, it } from 'bun:test'
import { feeFiatLabel, feeUsdFromNative } from './fee-fiat'

describe('feeUsdFromNative', () => {
	it('prices the fee in the native asset', () => {
		expect(feeUsdFromNative('0.00021', 3000)).toBeCloseTo(0.63, 10)
		expect(feeUsdFromNative('0.02', 1.5)).toBeCloseTo(0.03, 10)
	})

	it('reads the exponent notation EVM fees come in', () => {
		expect(feeUsdFromNative('1.3e-7', 3000)).toBeCloseTo(0.00039, 12)
	})

	it('gives no figure, never $0, without a fee or a price', () => {
		for (const fee of ['0', '', 'abc', undefined]) expect(feeUsdFromNative(fee, 3000)).toBeUndefined()
		for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(feeUsdFromNative('0.001', price)).toBeUndefined()
	})
})

describe('feeFiatLabel', () => {
	const fmt = (usd: number) => `$${usd.toFixed(2)}`

	it('shows the USD fee', () => {
		expect(feeFiatLabel(0.63, fmt)).toBe('$0.63')
		expect(feeFiatLabel(0.01, fmt)).toBe('$0.01')
	})

	it('shows a sub-cent fee as "<$0.01" (as Activity does), not "$0.00"', () => {
		expect(feeFiatLabel(0.00039, fmt)).toBe('<$0.01')
	})

	it('shows nothing without a figure', () => {
		expect(feeFiatLabel(undefined, fmt)).toBe('')
		expect(feeFiatLabel(0, fmt)).toBe('')
	})
})
