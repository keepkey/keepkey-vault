import { describe, expect, test } from 'bun:test'
import { buildAssetEntries } from '../src/shared/swap-discovery'
import { parseSwapFeeDisclosure } from '../src/bun/swap-fees'

describe('L2 native ETH is labelled ETH, not the chain token', () => {
  test('swap picker: Arbitrum, Optimism and Base native assets read ETH; the ARB/OP ERC-20s keep their own symbols', async () => {
    const entries = await buildAssetEntries({ swappable: [], balances: [], customTokens: [], firmwareVersion: '7.16.0' })
    const symbol = (caip: string) => entries.find(e => e.caip === caip)?.symbol
    expect(symbol('eip155:42161/slip44:60')).toBe('ETH')
    expect(symbol('eip155:10/slip44:60')).toBe('ETH')
    expect(symbol('eip155:8453/slip44:60')).toBe('ETH')
    expect(symbol('eip155:56/slip44:60')).toBe('BNB')
    // The real ARB token on Arbitrum One is unchanged.
    expect(symbol('eip155:42161/erc20:0x912ce59144191c1204e64559fe8253a0e49e6548')).toBe('ARB')
  })
})

describe('L2 native ETH in swap review fee rows (V16)', () => {
  test('swap review fee rows for L2 native fees read ETH', () => {
    const { items } = parseSwapFeeDisclosure({ fees: { affiliate: '1000000', outbound: '2000000' } }, {},
      { fromCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0', toCaip: 'eip155:8453/slip44:60', integration: 'thorchain' })
    expect(items.length).toBe(2)
    expect(items.every(item => item.symbol === 'ETH')).toBe(true)
    // A gateway's typed item naming the chain token is corrected for a built-in native too.
    const typed = parseSwapFeeDisclosure({ fees: { items: [{ kind: 'network', assetCaip: 'eip155:42161/slip44:60', symbol: 'ARB', decimals: 18, amountBaseUnits: '1000' }] } }, {},
      { fromCaip: 'eip155:42161/slip44:60', toCaip: 'eip155:1/slip44:60' })
    expect(typed.items[0].symbol).toBe('ETH')
  })
})
