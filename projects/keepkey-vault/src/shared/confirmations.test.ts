import { describe, expect, test } from 'bun:test'
import { CHAINS } from './chains'
import { getRequiredConfs } from './confirmations'

describe('getRequiredConfs (audit v6 U8)', () => {
	test('Polygon, listed under its current symbol POL, needs 128 confirmations', () => {
		const polygon = CHAINS.find(c => c.id === 'polygon')!
		expect(polygon.symbol).toBe('POL')
		expect(getRequiredConfs(polygon.symbol)).toBe(128)
	})

	test('activity rows saved with the old MATIC symbol still need 128', () => {
		expect(getRequiredConfs('MATIC')).toBe(128)
	})

	test('other chains are unchanged', () => {
		expect(getRequiredConfs('BTC')).toBe(6)
		expect(getRequiredConfs('ETH')).toBe(12)
		expect(getRequiredConfs('UNKNOWN')).toBe(6)
	})
})
