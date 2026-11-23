import type { ChainDef } from '../../shared/chains'

/**
 * networkId → chain for explorer links. Several chains can share a network (zcash and the
 * hidden zcash-shielded pool): the visible chain wins, since hidden ones have no explorer
 * entry of their own (audit v6 U5).
 */
export function chainsByNetwork(chains: ChainDef[]): Map<string, ChainDef> {
	const byNetwork = new Map<string, ChainDef>()
	for (const chain of chains) {
		const current = byNetwork.get(chain.networkId)
		if (!current || (current.hidden && !chain.hidden)) byNetwork.set(chain.networkId, chain)
	}
	return byNetwork
}
