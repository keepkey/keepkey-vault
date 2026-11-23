import { CHAINS, getExplorerTxUrl } from '../../shared/chains'

/**
 * Explorer link for an activity row. The chain is looked up exactly as the rows always did
 * (row chainId, else its symbol), and the URL comes from the shared getExplorerTxUrl, so the
 * list gets the same txid normalisation as the detail dialog, incl. TRON lowercase (audit v6 U9).
 */
export function activityExplorerUrl(chainKey: string | undefined, txid: string | undefined): string | null {
	if (!chainKey || !txid) return null
	const chain = CHAINS.find(c => c.symbol === chainKey || c.id === chainKey)
	return chain ? getExplorerTxUrl(chain.id, txid) : null
}
