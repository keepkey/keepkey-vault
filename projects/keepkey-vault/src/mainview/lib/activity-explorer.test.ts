import { describe, expect, test } from 'bun:test'
import { CHAINS } from '../../shared/chains'
import { activityExplorerUrl } from './activity-explorer'

// The list rows' former local helper, kept verbatim to prove nothing but TRON changes.
function previousRowUrl(chainSymbol: string, txid: string): string | null {
	if (!chainSymbol || !txid) return null
	const chain = CHAINS.find(c => c.symbol === chainSymbol || c.id === chainSymbol)
	if (!chain?.explorerTxUrl) return null
	const normalizedTxid = chain.chainFamily === 'evm'
		? (txid.startsWith('0x') ? txid : '0x' + txid)
		: txid.replace(/^0x/i, '')
	return chain.explorerTxUrl.replace('{{txid}}', normalizedTxid)
}

const TXIDS = ['abcdef0123456789', 'ABCDEF0123456789', '0xabcdef0123456789', '0XABCDEF0123456789']

describe('activityExplorerUrl (audit v6 U9)', () => {
	test('a TRON txid in upper case (as THORChain emits it) links in lower case', () => {
		const tron = CHAINS.find(c => c.chainFamily === 'tron')!
		const url = activityExplorerUrl(tron.id, 'EEB4ABCDEF')!
		expect(url).toContain('eeb4abcdef')
		expect(url).not.toContain('EEB4')
		expect(activityExplorerUrl(tron.symbol, 'EEB4ABCDEF')).toBe(url)
	})

	test('every other chain links exactly as before, by id and by symbol', () => {
		for (const chain of CHAINS.filter(c => c.chainFamily !== 'tron')) {
			for (const key of [chain.id, chain.symbol]) {
				for (const txid of TXIDS) expect(activityExplorerUrl(key, txid)).toBe(previousRowUrl(key, txid))
			}
		}
	})

	test('missing or unknown inputs give no link', () => {
		expect(activityExplorerUrl(undefined, 'abc')).toBeNull()
		expect(activityExplorerUrl('ethereum', undefined)).toBeNull()
		expect(activityExplorerUrl('ethereum', '')).toBeNull()
		expect(activityExplorerUrl('not-a-chain', 'abc')).toBeNull()
	})
})
