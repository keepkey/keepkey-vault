import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { relayFallbackTip, relaySignedFees } from './relay-fees'

// Audit v6 B11: with a quoted maxFeePerGas and no quoted maxPriorityFeePerGas,
// the signed tip was the cap itself, so the user paid the whole cap per gas.

const gwei = (n: number) => BigInt(Math.round(n * 1e9))

describe('Relay signed EIP-1559 fees', () => {
	it('signs the chosen tip, not the cap, when the quote has no tip', () => {
		const fees = relaySignedFees({
			quotedMaxFeePerGas: String(gwei(30)),
			liveFeePerGas: gwei(45),
			chosenPriorityFeePerGas: gwei(1.5),
		})
		expect(fees.signedFeePerGas).toBe(gwei(30))
		expect(fees.signedPrioFeePerGas).toBe(gwei(1.5))
	})

	// Built-in chains read fees through Pioneer, which has no fee history, so the
	// chosen tip is relayFallbackTip() for the chain.
	it('keeps Polygon at its 30 gwei fallback tip, which Polygon nodes require', () => {
		expect(relayFallbackTip('polygon')).toBe(gwei(30))
		const fees = relaySignedFees({
			quotedMaxFeePerGas: String(gwei(60)),
			liveFeePerGas: gwei(60),
			chosenPriorityFeePerGas: relayFallbackTip('polygon'),
		})
		expect(fees.signedPrioFeePerGas).toBe(gwei(30))
	})

	it('uses 1.5 gwei as the fallback tip on Ethereum and other chains', () => {
		expect(relayFallbackTip('ethereum')).toBe(gwei(1.5))
		expect(relayFallbackTip('optimism')).toBe(gwei(1.5))
		expect(relayFallbackTip('bsc')).toBe(gwei(1.5))
	})

	it('signs the quoted tip when there is one', () => {
		const fees = relaySignedFees({
			quotedMaxFeePerGas: String(gwei(30)),
			quotedPriorityFeePerGas: String(gwei(2)),
			liveFeePerGas: gwei(45),
			chosenPriorityFeePerGas: gwei(3),
		})
		expect(fees.signedPrioFeePerGas).toBe(gwei(2))
	})

	it('caps the tip at the signed maxFeePerGas, as nodes require', () => {
		// L2 quote: a 0.01 gwei cap under the 1.5 gwei tip floor.
		expect(relaySignedFees({
			quotedMaxFeePerGas: String(gwei(0.01)),
			liveFeePerGas: gwei(0.02),
			chosenPriorityFeePerGas: gwei(1.5),
		}).signedPrioFeePerGas).toBe(gwei(0.01))
		// A quoted tip above the quoted cap would make the tx invalid.
		expect(relaySignedFees({
			quotedMaxFeePerGas: String(gwei(3)),
			quotedPriorityFeePerGas: String(gwei(5)),
			liveFeePerGas: gwei(4),
		}).signedPrioFeePerGas).toBe(gwei(3))
	})

	it('signs the RPC tip on the approve when the quote has no fees at all', () => {
		const fees = relaySignedFees({ liveFeePerGas: gwei(40), chosenPriorityFeePerGas: gwei(2) })
		expect(fees.signedFeePerGas).toBe(gwei(40))
		expect(fees.signedPrioFeePerGas).toBe(gwei(2))
	})

	it('falls back to the live fee as the cap when no quoted cap is usable', () => {
		const fees = relaySignedFees({ quotedMaxFeePerGas: undefined, liveFeePerGas: gwei(12) })
		expect(fees.signedFeePerGas).toBe(gwei(12))
	})
})

describe('Relay swap builder wiring', () => {
	const src = readFileSync(new URL('./swap.ts', import.meta.url), 'utf8')

	it('takes both signed fees from relaySignedFees, with the quote gated by eip1559Ok', () => {
		expect(src.match(/= relaySignedFees\(/g)?.length).toBe(1)
		expect(src).toContain('quotedMaxFeePerGas: eip1559Ok ? relay.maxFeePerGas : undefined')
		expect(src).toContain('chosenPriorityFeePerGas: maxPriorityFeePerGas ? BigInt(maxPriorityFeePerGas) : undefined')
		// The swap tx signs the quoted fields under the same gate the helper uses.
		expect(src).toMatch(/if \(relay\.maxFeePerGas && eip1559Ok\) \{\n\s+unsignedTx\.maxFeePerGas = toHex\(signedFeePerGas\)/)
	})

	it('starts a quote without a tip from the chain fallback tip, never a fixed 1.5 gwei', () => {
		expect(src).toContain(': relayFallbackTip(fromChain.id)')
		expect(src).not.toMatch(/BigInt\(1_500_000_000\)/)
	})

	it('signs that tip on the swap tx and on the ERC-20 approve', () => {
		expect(src.match(/\.maxPriorityFeePerGas = toHex\(signedPrioFeePerGas\)/g)?.length).toBe(2)
	})
})
