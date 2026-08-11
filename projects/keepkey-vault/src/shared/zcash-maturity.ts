/**
 * Transparent Zcash UTXOs are intentionally held for ten confirmations before
 * Vault offers them to Send, Swap, or Shield. Keeping the calculation here
 * gives the balance UI and every transaction builder one definition of
 * "spendable".
 */
export const ZCASH_MIN_CONFIRMATIONS = 10

export interface ZcashUtxoLike {
	value?: number | string
	amount?: number | string
	confirmations?: number | string
	height?: number | string
}

export interface ZcashMaturitySummary {
	totalZat: number
	spendableZat: number
	lockedZat: number
	spendableCount: number
	lockedCount: number
	/** Highest confirmation count among locked outputs: the next batch to unlock. */
	nextUnlockConfirmations: number | null
	unknownConfirmationsCount: number
}

function finiteInteger(value: unknown): number | null {
	if (typeof value !== 'number' && typeof value !== 'string') return null
	const parsed = typeof value === 'number' ? value : Number(value)
	return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/** Pioneer uses integer zatoshis, while a few compatible backends use ZEC. */
export function zcashUtxoValueZat(utxo: ZcashUtxoLike): number {
	const raw = utxo.value ?? utxo.amount ?? 0
	const text = String(raw).trim()
	if (!text) return 0
	const parsed = text.includes('.')
		? Math.round(Number(text) * 1e8)
		: Number.parseInt(text, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Resolve confirmations without guessing. ListUnspent normally supplies the
 * field directly; height is a safe fallback only when a chain tip is known.
 */
export function zcashUtxoConfirmations(
	utxo: ZcashUtxoLike,
	tipHeight?: number | null,
): number | null {
	const direct = finiteInteger(utxo.confirmations)
	if (direct !== null) return Math.max(0, direct)

	const height = finiteInteger(utxo.height)
	if (height === null || height <= 0 || tipHeight == null || !Number.isFinite(tipHeight)) return null
	return Math.max(0, Math.trunc(tipHeight) - height + 1)
}

export function summarizeZcashMaturity(
	utxos: ZcashUtxoLike[],
	tipHeight?: number | null,
): ZcashMaturitySummary {
	let totalZat = 0
	let spendableZat = 0
	let lockedZat = 0
	let spendableCount = 0
	let lockedCount = 0
	let nextUnlockConfirmations: number | null = null
	let unknownConfirmationsCount = 0

	for (const utxo of utxos) {
		const value = zcashUtxoValueZat(utxo)
		if (value <= 0) continue
		totalZat += value

		const confirmations = zcashUtxoConfirmations(utxo, tipHeight)
		// Preserve the existing fail-open behavior when an indexer gives neither
		// confirmations nor a usable height. We do not label unknown funds locked,
		// and the builder uses the same rule.
		if (confirmations === null) {
			unknownConfirmationsCount++
			spendableCount++
			spendableZat += value
			continue
		}

		if (confirmations >= ZCASH_MIN_CONFIRMATIONS) {
			spendableCount++
			spendableZat += value
		} else {
			lockedCount++
			lockedZat += value
			nextUnlockConfirmations = Math.max(nextUnlockConfirmations ?? 0, confirmations)
		}
	}

	return {
		totalZat,
		spendableZat,
		lockedZat,
		spendableCount,
		lockedCount,
		nextUnlockConfirmations,
		unknownConfirmationsCount,
	}
}

/** Unknown confirmation metadata remains usable; known sub-10 outputs do not. */
export function filterSpendableZcashUtxos<T extends ZcashUtxoLike>(
	utxos: T[],
	tipHeight?: number | null,
): T[] {
	return utxos.filter(utxo => {
		const confirmations = zcashUtxoConfirmations(utxo, tipHeight)
		return confirmations === null || confirmations >= ZCASH_MIN_CONFIRMATIONS
	})
}

export function formatZatAsZec(zat: number): string {
	if (!Number.isFinite(zat) || zat <= 0) return '0'
	return (zat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
}
