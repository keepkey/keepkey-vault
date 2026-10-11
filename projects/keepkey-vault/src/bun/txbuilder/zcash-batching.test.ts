import { describe, expect, it } from 'bun:test'
import { MAX_TRANSPARENT_INPUTS, maxShieldable, partialSend, planShieldBatches, shieldFee } from './zcash-batching'

const ZEC = 100_000_000
const utxos = (values: number[]) => values.map((value, i) => ({ txid: `${i}`, value }))

function checkPlan(input: { value: number }[], amount: number) {
	const batches = planShieldBatches(input, amount)
	const seen = new Set<object>()
	let shielded = 0
	batches.forEach((b, i) => {
		expect(b.inputs.length).toBeLessThanOrEqual(MAX_TRANSPARENT_INPUTS)
		expect(b.fee).toBe(shieldFee(b.inputs.length))
		const sum = b.inputs.reduce((s, u) => s + u.value, 0)
		expect(sum).toBe(b.amount + b.fee + b.change)
		if (i < batches.length - 1) expect(b.change).toBe(0)
		for (const u of b.inputs) {
			expect(seen.has(u)).toBe(false)
			seen.add(u)
		}
		shielded += b.amount
	})
	expect(shielded).toBe(amount)
	return batches
}

describe('planShieldBatches', () => {
	it('fits 8 inputs in one transaction', () => {
		const u = utxos(Array(8).fill(ZEC))
		const batches = checkPlan(u, 8 * ZEC - shieldFee(8))
		expect(batches).toHaveLength(1)
		expect(batches[0].inputs).toHaveLength(8)
	})

	it('splits 9 inputs into two transactions', () => {
		const u = utxos(Array(9).fill(ZEC))
		const batches = checkPlan(u, maxShieldable(u))
		expect(batches.map(b => b.inputs.length)).toEqual([8, 1])
	})

	it('shields 40 UTXOs ("Max") in five transactions', () => {
		const u = utxos(Array.from({ length: 40 }, (_, i) => (i + 1) * 100_000))
		const max = maxShieldable(u)
		const batches = checkPlan(u, max)
		expect(batches).toHaveLength(5)
		expect(batches.every(b => b.inputs.length === 8)).toBe(true)
		expect(() => planShieldBatches(u, max + 1)).toThrow('Insufficient transparent balance')
	})

	it('uses only the largest UTXO for a small shield', () => {
		const u = utxos([20_000, 3 * ZEC, ZEC])
		const batches = checkPlan(u, ZEC)
		expect(batches).toHaveLength(1)
		expect(batches[0].inputs.map(x => x.value)).toEqual([3 * ZEC])
		expect(batches[0].change).toBe(2 * ZEC - shieldFee(1))
	})

	it('never spends dust and rejects bad amounts', () => {
		const u = utxos([5000, ZEC])
		expect(maxShieldable(u)).toBe(ZEC - shieldFee(1))
		expect(() => planShieldBatches(u, 0)).toThrow()
		expect(() => planShieldBatches(u, 1.5)).toThrow()
	})

	it('keeps the old single-transaction fee', () => {
		// 5000 * max(2, max(inputs, 1 change output) + 2 Ironwood actions)
		expect(shieldFee(1)).toBe(15_000)
		expect(shieldFee(8)).toBe(50_000)
	})
})

describe('partialSend', () => {
	it('reports what went out and what is left, so a retry cannot pay the full amount again', () => {
		expect(partialSend(['aa', 'bb'], 200_000_000, new Error('Cancelled on device'))).toEqual({
			txid: 'bb', txids: ['aa', 'bb'], unsentZat: 200_000_000, unsentReason: 'Cancelled on device',
		})
	})

	it('is never a result when nothing was sent or nothing is left', () => {
		expect(() => partialSend([], 1, new Error('x'))).toThrow()
		expect(() => partialSend(['aa'], 0, new Error('x'))).toThrow()
	})
})

