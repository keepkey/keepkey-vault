import { describe, expect, it } from 'bun:test'
import { checkShieldedSignatureCount, exportOrchardFvk } from './zcash-shielded'

const sr = (spends: boolean[]) => ({
	n_actions: spends.length,
	actions: spends.map(is_spend => ({ is_spend })) as any,
})

describe('checkShieldedSignatureCount', () => {
	it('accepts one signature per real spend (firmware 7.15)', () => {
		expect(() => checkShieldedSignatureCount(1, sr([true, false]))).not.toThrow()
	})

	it('accepts one signature per action (earlier release candidates)', () => {
		expect(() => checkShieldedSignatureCount(2, sr([true, false]))).not.toThrow()
	})

	it('rejects any other count', () => {
		expect(() => checkShieldedSignatureCount(0, sr([true, false]))).toThrow('Signature count mismatch')
		expect(() => checkShieldedSignatureCount(3, sr([true, true, false, false]))).toThrow('Signature count mismatch')
	})
})

describe('exportOrchardFvk', () => {
	it('reads straight from a physical device, which has its own button', async () => {
		const fvk = { ak: new Uint8Array([1]) }
		const wallet = { transport: { delegate: {} }, zcashGetOrchardFVK: async (account: number) => ({ ...fvk, account }) }
		expect(await exportOrchardFvk(wallet, 2)).toEqual({ ...fvk, account: 2 })
	})
})
