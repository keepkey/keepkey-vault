import { describe, it, expect } from 'bun:test'
import { detectSpamToken } from './spamFilter'

// The canonical issuer contracts. If the discovery catalog loses one of these,
// the vault brands a real stablecoin "SCAM" in the user's token list — which is
// exactly how USDT-on-Gnosis got flagged.
const CANONICAL: Array<[string, string]> = [
	['USDT eth',    'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7'],
	['USDT op',     'eip155:10/erc20:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58'],
	['USDT polygon','eip155:137/erc20:0xc2132d05d31c914a87c6611c10748aeb04b58e8f'],
	['USDT arb',    'eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'],
	['USDT avax',   'eip155:43114/erc20:0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7'],
	['USDT base',   'eip155:8453/erc20:0xfde4c96c8593536e31f229ea8f37b2ada2699bb2'],
	['USDT bsc',    'eip155:56/erc20:0x55d398326f99059ff775485246999027b3197955'],
	['USDT gnosis', 'eip155:100/erc20:0x4ecaba5870353805a9f068101a40e0f32ed605c6'],
	['USDC eth',    'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
	['USDC op',     'eip155:10/erc20:0x0b2c639c533813f4aa9d7837caf62653d097ff85'],
	['USDC polygon','eip155:137/erc20:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'],
	['USDC arb',    'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831'],
	['USDC avax',   'eip155:43114/erc20:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'],
	['USDC base',   'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
	['USDC bsc',    'eip155:56/erc20:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'],
	['USDC gnosis', 'eip155:100/erc20:0xddafbb505ad214d7b80b1f830fccc89b60fb7a83'],
]

describe('detectSpamToken', () => {
	for (const [label, caip] of CANONICAL) {
		it(`does not flag ${label}`, () => {
			expect(detectSpamToken({ caip } as any).isSpam).toBe(false)
		})
	}

	it('flags an unknown contract', () => {
		expect(detectSpamToken({ caip: 'eip155:100/erc20:0xdeadbeef00000000000000000000000000000000' } as any).isSpam).toBe(true)
	})

	// Regression: the catalog used to carry this BSC contract as symbol "USDT" while
	// the contract itself declares "USD.T" / "TENTER USD.T" and is unlisted on
	// CoinGecko — i.e. we were whitelisting a Tether lookalike. Removed in
	// pioneer-discovery 10.3.2. If a catalog regeneration reintroduces it, fail here.
	it('flags the TENTER USD.T impersonator on BSC', () => {
		expect(detectSpamToken({ caip: 'eip155:56/bep20:0x5e0a1d876557cf43c66c08c8a247bc4954eca8bd' } as any).isSpam).toBe(true)
	})

	// The genuine BSC USDT must survive that removal.
	it('does not flag real BSC USDT', () => {
		expect(detectSpamToken({ caip: 'eip155:56/erc20:0x55d398326f99059ff775485246999027b3197955' } as any).isSpam).toBe(false)
	})
})
