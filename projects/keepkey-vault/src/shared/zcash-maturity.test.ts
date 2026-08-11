import { describe, expect, it } from 'bun:test'
import {
	filterSpendableZcashUtxos,
	formatZatAsZec,
	summarizeZcashMaturity,
	ZCASH_MIN_CONFIRMATIONS,
} from './zcash-maturity'

describe('transparent Zcash maturity', () => {
	it('splits mature and locked outputs at exactly ten confirmations', () => {
		const summary = summarizeZcashMaturity([
			{ value: '14727242', confirmations: 10 },
			{ value: '10000', confirmations: 4 },
		])

		expect(ZCASH_MIN_CONFIRMATIONS).toBe(10)
		expect(summary.totalZat).toBe(14737242)
		expect(summary.spendableZat).toBe(14727242)
		expect(summary.lockedZat).toBe(10000)
		expect(summary.spendableCount).toBe(1)
		expect(summary.lockedCount).toBe(1)
		expect(summary.nextUnlockConfirmations).toBe(4)
	})

	it('uses the closest locked output for the compact progress counter', () => {
		const summary = summarizeZcashMaturity([
			{ value: 1, confirmations: 2 },
			{ value: 1, confirmations: 8 },
			{ value: 1, confirmations: 5 },
		])
		expect(summary.nextUnlockConfirmations).toBe(8)
	})

	it('derives confirmations from height when a tip is available', () => {
		const summary = summarizeZcashMaturity([{ amount: '0.5', height: '100' }], 103)
		expect(summary.lockedZat).toBe(50_000_000)
		expect(summary.nextUnlockConfirmations).toBe(4)
	})

	it('keeps unknown-confirmation outputs usable instead of inventing a lock', () => {
		const utxos = [{ value: 10_000 }, { value: 20_000, confirmations: '3' }]
		const summary = summarizeZcashMaturity(utxos)
		expect(summary.unknownConfirmationsCount).toBe(1)
		expect(summary.spendableZat).toBe(10_000)
		expect(filterSpendableZcashUtxos(utxos)).toEqual([utxos[0]])
	})

	it('formats zatoshis without floating zero noise', () => {
		expect(formatZatAsZec(14_727_242)).toBe('0.14727242')
		expect(formatZatAsZec(10_000)).toBe('0.0001')
	})
})
