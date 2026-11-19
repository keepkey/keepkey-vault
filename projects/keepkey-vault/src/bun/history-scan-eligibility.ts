import { isChainSupported, type ChainDef } from '../shared/chains'

/**
 * Chains the activity-history rebuild scans at all. Anything else is skipped by design
 * (no Pioneer history, or unsupported by this firmware), not a failed scan (audit v6 U4).
 */
export function isHistoryScanChain(chain: ChainDef, firmwareVersion: string | undefined, includeHidden = false): boolean {
	return (includeHidden || !chain.hidden)
		&& chain.chainFamily !== 'zcash-shielded'
		&& chain.chainFamily !== 'monero'
		&& isChainSupported(chain, firmwareVersion)
}
