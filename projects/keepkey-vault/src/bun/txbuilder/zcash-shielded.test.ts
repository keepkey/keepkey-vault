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

	it('asks the device once per wallet', async () => {
		let reads = 0
		let address = '0xAAA'
		const wallet = {
			transport: { delegate: {} },
			ethGetAddress: async () => address,
			zcashGetOrchardFVK: async () => {
				reads++
				return { ak: new Uint8Array([reads]), nk: new Uint8Array([2]), rivk: new Uint8Array([3]) }
			},
		}
		const first = await exportOrchardFvk(wallet, 0)
		expect(await exportOrchardFvk(wallet, 0)).toBe(first)
		expect(reads).toBe(1)

		address = '0xBBB' // another seed or passphrase
		expect((await exportOrchardFvk(wallet, 0)).ak).toEqual(new Uint8Array([2]))
		expect(reads).toBe(2)
	})
})
