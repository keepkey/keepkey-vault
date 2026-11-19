/** How far past the next unused index the BTC receive "+" button may step. */
export const MAX_NEW_BTC_ADDRESSES = 10

type Indices = { receiveIndex: number; changeIndex: number } | null | undefined

/** Highest address index "+" may reach on a branch (0 = receive, 1 = change). */
export function btcAddressIndexLimit(indices: Indices, change: 0 | 1): number {
	const next = indices ? (change === 1 ? indices.changeIndex : indices.receiveIndex) : 0
	return next + MAX_NEW_BTC_ADDRESSES
}
