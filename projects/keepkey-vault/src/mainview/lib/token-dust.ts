import type { TokenBalance } from '../../shared/types'

/** Below this USD value a priced token is "dust": grouped under Small balances. */
export const DUST_USD = 0.01

/** Split tokens into the main list and dust. Only tokens with a known price
 *  count as dust — a missing price feed reports balanceUsd 0 for real
 *  holdings, and those must never be tucked away as "small". */
export function splitDustTokens<T extends Pick<TokenBalance, 'balanceUsd' | 'priceUsd'>>(tokens: readonly T[]) {
	const main: T[] = []
	const dust: T[] = []
	for (const tok of tokens) {
		const priced = (tok.priceUsd ?? 0) > 0
		;(priced && (tok.balanceUsd ?? 0) < DUST_USD ? dust : main).push(tok)
	}
	return { main, dust }
}
