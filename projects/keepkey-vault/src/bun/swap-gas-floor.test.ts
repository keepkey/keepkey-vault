import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { pioneerGasQuoteWei, swapGasFallbackWei, swapGasFloorWei, swapGasMinimumWei, swapGasPriceWei } from './swap-gas-floor'
import { buildEvmTx } from './txbuilder/evm'
import { CHAINS } from '../shared/chains'

// Audit v6 B12: BSC was floored at 3 gwei and Avalanche at 25 gwei, 10–30× the
// network quote, on sends (evm.ts) and swaps (MIN_GAS_GWEI).
const gwei = (n: number) => BigInt(Math.round(n * 1e9))

describe('swap gas floor', () => {
	it('signs the BSC and Avalanche quote instead of 3 / 25 gwei', () => {
		expect(swapGasPriceWei('bsc', gwei(0.1))).toBe(gwei(0.1))
		// Avalanche: the quote with 25% headroom over the base fee.
		expect(swapGasPriceWei('avalanche', gwei(0.8))).toBe(gwei(1))
	})

	it('raises a quote under the network minimum to it', () => {
		expect(swapGasFloorWei('bsc')).toBe(gwei(0.05))
		expect(swapGasPriceWei('bsc', gwei(0.01))).toBe(gwei(0.05))
	})

	it('keeps a conservative price when there is no quote', () => {
		expect(swapGasPriceWei('avalanche', null)).toBe(swapGasFallbackWei('avalanche'))
		expect(swapGasFallbackWei('avalanche')).toBe(gwei(25))
		expect(swapGasPriceWei('bsc', 0n)).toBe(gwei(1))
	})

	it('leaves the other chains as they were', () => {
		expect(swapGasPriceWei('ethereum', gwei(1))).toBe(gwei(3))
		expect(swapGasPriceWei('polygon', gwei(5))).toBe(gwei(30))
		expect(swapGasPriceWei('base', gwei(0.01))).toBe(gwei(0.05))
		expect(swapGasPriceWei('some-new-chain', null)).toBe(gwei(10))
	})

	it('never lets the slow level sign under what BSC or Avalanche accept', () => {
		expect(swapGasMinimumWei('bsc', gwei(0.05))).toBe(gwei(0.05))
		// KEEPKEY-164: on BSC the quote is the floor, so slow never signs under it.
		expect(swapGasMinimumWei('bsc', gwei(0.1))).toBe(gwei(0.1))
		expect(swapGasMinimumWei('bsc', gwei(0.01))).toBe(gwei(0.05))
		expect(swapGasMinimumWei('bsc', null)).toBe(gwei(0.05))
		expect(swapGasMinimumWei('avalanche', gwei(0.8))).toBe(gwei(1))
		expect(swapGasMinimumWei('ethereum', gwei(1))).toBe(0n)
	})

	it('reads Pioneer gas quotes', () => {
		expect(pioneerGasQuoteWei({ average: '0.1' })).toBe(gwei(0.1))
		expect(pioneerGasQuoteWei({ average: '', fast: '0.2' })).toBe(gwei(0.2))
		expect(pioneerGasQuoteWei('0.05')).toBe(gwei(0.05))
		for (const bad of [undefined, null, '', 'abc', '0', { average: '-1' }]) expect(pioneerGasQuoteWei(bad)).toBeNull()
	})

	it('is what both swap fee paths use', () => {
		const swap = readFileSync(new URL('./swap.ts', import.meta.url), 'utf8')
		expect(swap).not.toContain('MIN_GAS_GWEI')
		expect(swap.match(/swapGasPriceWei\(fromChain\.id,/g)?.length).toBe(3)
		expect(swap).toContain('swapGasMinimumWei(fromChain.id, quoteWei)')
	})
})

describe('EVM send gas price', () => {
	const from = '0x000000000000000000000000000000000000bEEF'
	const to = '0x000000000000000000000000000000000000dEaD'
	const chain = (id: string) => CHAINS.find(c => c.id === id)!
	const pioneer = (quoteGwei: string) => ({
		GetGasPriceByNetwork: async () => ({ data: { average: quoteGwei } }),
		GetNonceByNetwork: async () => ({ data: { nonce: 1 } }),
		GetBalanceAddressByNetwork: async () => ({ data: { balance: '10' } }),
	})
	let originalFetch: typeof fetch
	beforeEach(() => { originalFetch = globalThis.fetch; globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch })
	afterEach(() => { globalThis.fetch = originalFetch })

	it('signs the BSC quote (0.1 gwei), not 3 gwei', async () => {
		const tx = await buildEvmTx(pioneer('0.1'), chain('bsc'), { to, amount: '0.01', fromAddress: from })
		expect(BigInt(tx.gasPrice)).toBe(gwei(0.1))
	})

	it('signs the Avalanche quote with 25% headroom (1 gwei), not 25 gwei', async () => {
		const tx = await buildEvmTx(pioneer('0.8'), chain('avalanche'), { to, amount: '0.01', fromAddress: from })
		expect(BigInt(tx.gasPrice)).toBe(gwei(1))
	})

	it('never signs a BSC send under the validators\' 0.05 gwei minimum', async () => {
		const tx = await buildEvmTx(pioneer('0.03'), chain('bsc'), { to, amount: '0.01', fromAddress: from })
		expect(BigInt(tx.gasPrice)).toBe(gwei(0.05))
	})

	// KEEPKEY-164: 80% of the quote (0.08 gwei) is under what the network is
	// pricing, so the slow tx could sit unmined.
	it('the slow level never signs a BSC send under its quote or 0.05 gwei', async () => {
		const slow = await buildEvmTx(pioneer('0.1'), chain('bsc'), { to, amount: '0.01', fromAddress: from, feeLevel: 1 })
		expect(BigInt(slow.gasPrice)).toBe(gwei(0.1))
		const atMinimum = await buildEvmTx(pioneer('0.05'), chain('bsc'), { to, amount: '0.01', fromAddress: from, feeLevel: 1 })
		expect(BigInt(atMinimum.gasPrice)).toBe(gwei(0.05))
	})

	it('the slow level never signs Avalanche under its quote', async () => {
		const tx = await buildEvmTx(pioneer('0.8'), chain('avalanche'), { to, amount: '0.01', fromAddress: from, feeLevel: 1 })
		expect(BigInt(tx.gasPrice) >= gwei(0.8)).toBe(true)
	})

	it('accepts the price it signs by default when the user types it as a custom fee', async () => {
		// The custom-fee check refuses 10× the quote; a 3 gwei default on a 0.1 gwei quote failed it.
		for (const id of ['bsc', 'avalanche']) {
			const quote = id === 'bsc' ? '0.1' : '0.8'
			const defaultTx = await buildEvmTx(pioneer(quote), chain(id), { to, amount: '0.01', fromAddress: from })
			const typed = String(Number(BigInt(defaultTx.gasPrice)) / 1e9)
			const customTx = await buildEvmTx(pioneer(quote), chain(id), { to, amount: '0.01', fromAddress: from, gasPriceGwei: typed })
			expect(BigInt(customTx.gasPrice)).toBe(BigInt(defaultTx.gasPrice))
		}
	})

	it('keeps the 30 gwei Polygon floor', async () => {
		const tx = await buildEvmTx(pioneer('5'), chain('polygon'), { to, amount: '0.01', fromAddress: from })
		expect(BigInt(tx.gasPrice)).toBe(gwei(30))
	})
})
