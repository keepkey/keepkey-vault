import { describe, expect, test } from 'bun:test'
import { CHAINS, getExplorerTxUrl, type ChainDef } from '../../shared/chains'
import { chainsByNetwork } from './chain-by-network'

const zcash = CHAINS.find(c => c.id === 'zcash')!

describe('chainsByNetwork (audit v6 U5)', () => {
	test('a Zcash outbound resolves to the visible zcash chain and gets an explorer link', () => {
		const chain = chainsByNetwork(CHAINS).get(zcash.networkId)!
		expect(chain.id).toBe('zcash')
		expect(getExplorerTxUrl(chain.id, 'abc123')).toBeTruthy()
	})

	test('the visible chain wins whatever the order', () => {
		const shielded = CHAINS.find(c => c.id === 'zcash-shielded')!
		expect(chainsByNetwork([zcash, shielded]).get(zcash.networkId)!.id).toBe('zcash')
		expect(chainsByNetwork([shielded, zcash]).get(zcash.networkId)!.id).toBe('zcash')
	})

	test('a hidden chain alone on its network is still found', () => {
		const lone = { ...zcash, id: 'lone', networkId: 'test:lone', hidden: true } as ChainDef
		expect(chainsByNetwork([lone]).get('test:lone')!.id).toBe('lone')
	})

	test('every other network maps to the same chain as before', () => {
		const shared = new Set(CHAINS.filter(c => CHAINS.some(o => o !== c && o.networkId === c.networkId)).map(c => c.networkId))
		const before = new Map(CHAINS.map(c => [c.networkId, c]))
		const after = chainsByNetwork(CHAINS)
		for (const [networkId, chain] of before) if (!shared.has(networkId)) expect(after.get(networkId)).toBe(chain)
	})
})
