/**
 * Normalise what an address-derivation RPC returns into the string to show.
 * Most chains answer a string or `{ address }`; hiveGetPublicKey answers
 * `{ publicKey }` (an STM key, which is what Hive receives on). The old
 * `result?.address || String(result)` turned that into "[object Object]",
 * so the Hive page looked the account up with garbage (KEEPKEY-50 / audit A1).
 * Returns null for anything that isn't a non-empty string, so callers show an
 * error instead of a bogus address.
 */
export function addressFromDeriveResult(result: unknown): string | null {
	if (typeof result === 'string') return result.trim() || null
	if (result && typeof result === 'object') {
		const r = result as { address?: unknown; publicKey?: unknown }
		for (const v of [r.address, r.publicKey]) {
			if (typeof v === 'string' && v.trim()) return v.trim()
		}
	}
	return null
}
