import { describe, expect, test } from 'bun:test'
import { CHAINS, type ChainDef } from '../shared/chains'
import { isHistoryScanChain } from './history-scan-eligibility'

const chain = (id: string) => CHAINS.find(c => c.id === id)!
const gated = CHAINS.find(c => c.minFirmware && !c.hidden && c.chainFamily !== 'zcash-shielded')!

describe('isHistoryScanChain (audit v6 U4)', () => {
	test('regular chains are scanned', () => {
		expect(isHistoryScanChain(chain('bitcoin'), '7.17.0')).toBe(true)
		expect(isHistoryScanChain(chain('ethereum'), '7.17.0')).toBe(true)
	})

	test('chains without Pioneer history are skipped, not failed', () => {
		for (const c of CHAINS.filter(c => c.chainFamily === 'zcash-shielded' || c.chainFamily === 'monero')) {
			expect(isHistoryScanChain(c, '99.0.0', true)).toBe(false)
		}
	})

	test('a chain below its firmware minimum is skipped', () => {
		expect(isHistoryScanChain(gated, '7.0.0')).toBe(false)
		expect(isHistoryScanChain(gated, gated.minFirmware)).toBe(true)
		expect(isHistoryScanChain(gated, undefined)).toBe(false)
	})

	test('hidden chains are skipped unless the caller includes them', () => {
		const hidden = { ...chain('ethereum'), hidden: true } as ChainDef
		expect(isHistoryScanChain(hidden, '7.17.0')).toBe(false)
		expect(isHistoryScanChain(hidden, '7.17.0', true)).toBe(true)
	})
})
