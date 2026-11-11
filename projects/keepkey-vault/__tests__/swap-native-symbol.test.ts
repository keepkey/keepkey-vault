import { describe, expect, test } from 'bun:test'
import { buildAssetEntries } from '../src/shared/swap-discovery'

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
