/**
 * Split a shield (transparent → Ironwood) into transactions the KeepKey can
 * sign. Firmware 7.15 accepts at most 8 transparent inputs per transaction,
 * so shielding many UTXOs ("Max") takes several transactions. They spend
 * disjoint UTXOs, so they are signed and broadcast one after another
 * without waiting for confirmations.
 */

/** Firmware 7.15: transparent inputs per Zcash transaction. */
export const MAX_TRANSPARENT_INPUTS = 8

const MARGINAL_FEE = 5000

/** ZIP-317 fee for a shield: transparent inputs (or the one change output,
 *  whichever is more) plus the two padded Ironwood actions. */
export function shieldFee(nInputs: number): number {
	return MARGINAL_FEE * Math.max(2, Math.max(nInputs, 1) + 2)
}

export interface ShieldBatch<U> {
	inputs: U[]
	/** Zatoshis this transaction moves into Ironwood. */
	amount: number
	fee: number
	/** Left over, returned to the transparent address (last batch only). */
	change: number
}

/** UTXOs worth spending, largest first: one at or below the marginal fee
 *  costs more to shield than it carries. */
function spendOrder<U extends { value: number }>(utxos: U[]): U[] {
	return utxos.filter(u => u.value > MARGINAL_FEE).sort((a, b) => b.value - a.value)
}

/** The most a shield can move into Ironwood, across as many transactions
 *  as it takes. */
export function maxShieldable<U extends { value: number }>(utxos: U[]): number {
	const order = spendOrder(utxos)
	let total = 0
	for (let i = 0; i < order.length; i += MAX_TRANSPARENT_INPUTS) {
		const chunk = order.slice(i, i + MAX_TRANSPARENT_INPUTS)
		const sum = chunk.reduce((s, u) => s + u.value, 0)
		total += Math.max(0, sum - shieldFee(chunk.length))
	}
	return total
}

/** Plan a shield of `amount` zatoshis. Every batch but the last spends 8
 *  UTXOs and shields all of them; the last covers the rest with change. */
export function planShieldBatches<U extends { value: number }>(utxos: U[], amount: number): ShieldBatch<U>[] {
	if (!Number.isInteger(amount) || amount <= 0) throw new Error("Shield amount must be a positive integer (zatoshis)")
	const order = spendOrder(utxos)
	const batches: ShieldBatch<U>[] = []
	let remaining = amount
	let cursor = 0
	while (remaining > 0) {
		const rest = order.slice(cursor)
		let sum = 0
		for (let k = 0; k < Math.min(rest.length, MAX_TRANSPARENT_INPUTS); k++) {
			sum += rest[k].value
			const fee = shieldFee(k + 1)
			if (sum >= remaining + fee) {
				batches.push({ inputs: rest.slice(0, k + 1), amount: remaining, fee, change: sum - remaining - fee })
				return batches
			}
		}
		const fee = shieldFee(MAX_TRANSPARENT_INPUTS)
		if (rest.length <= MAX_TRANSPARENT_INPUTS || sum <= fee) {
			throw new Error(
				`Insufficient transparent balance: can shield at most ${maxShieldable(utxos)} ZAT after fees, asked for ${amount} ZAT`
			)
		}
		batches.push({ inputs: rest.slice(0, MAX_TRANSPARENT_INPUTS), amount: sum - fee, fee, change: 0 })
		remaining -= sum - fee
		cursor += MAX_TRANSPARENT_INPUTS
	}
	return batches
}
