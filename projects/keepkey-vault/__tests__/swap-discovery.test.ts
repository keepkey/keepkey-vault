/**
 * Tests for the asset-picker discovery layer's pure logic: bucket selection,
 * sort comparator, and ranked search. Synthetic AssetEntry inputs only — no
 * pioneer-discovery JSON dependency, so the full bundle stays out of the
 * test runner.
 *
 * The composite score formula `matchRank * 10 + bucket` is the user-facing
 * contract; these cases pin the boundaries that drove that choice (notably
 * "bitcoin" → BTC over BITCOIN memecoin, and "tron" → TRX even though it's
 * unsupported).
 *
 * Run: bun test __tests__/swap-discovery.test.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  bucketFor,
  compareEntries,
  buildSearchIndex,
  searchEntries,
  chainMetaForCaip2,
  canonicalizeCaip,
  canonicalizeChainCaip2,
  synthesizeSwapAsset,
  type AssetEntry,
} from '../src/shared/swap-discovery'

function entry(partial: Partial<AssetEntry> & Pick<AssetEntry, 'caip' | 'symbol' | 'name'>): AssetEntry {
  return {
    caip: partial.caip,
    symbol: partial.symbol,
    name: partial.name,
    chainId: partial.chainId ?? partial.caip.split('/')[0],
    decimals: partial.decimals ?? 18,
    iconUrl: partial.iconUrl,
    isNative: partial.isNative ?? !partial.caip.includes('/erc20:'),
    balance: partial.balance,
    swappable: partial.swappable,
    swappableAsset: partial.swappableAsset,
    availability: partial.availability ?? { status: 'unknown', providers: [] },
  }
}

describe('bucketFor', () => {
  const swap = { asset: 'BTC.BTC', chainId: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', chainFamily: 'utxo', decimals: 8 } as any

  test('held with USD value → bucket 0', () => {
    const e = entry({
      caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0',
      symbol: 'BTC', name: 'Bitcoin',
      balance: { amount: '0.5', usd: 30000 },
      availability: { status: 'swappable', providers: ['thorchain'] },
    })
    expect(bucketFor(e)).toBe(0)
  })

  test('held with $0 (no price feed) → bucket 1', () => {
    const e = entry({
      caip: 'eip155:1/erc20:0xfoobar', symbol: 'WUT', name: 'WUT',
      balance: { amount: '1', usd: 0 },
      availability: { status: 'unknown', providers: [] },
    })
    expect(bucketFor(e)).toBe(1)
  })

  test('Pioneer-confirmed swappable native (not held) → bucket 2', () => {
    const e = entry({
      caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0',
      symbol: 'BTC', name: 'Bitcoin',
      swappable: swap,
      availability: { status: 'swappable', providers: ['thorchain'] },
    })
    expect(bucketFor(e)).toBe(2)
  })

  test('Pioneer-confirmed swappable token (not held) → bucket 3', () => {
    const e = entry({
      caip: 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7',
      symbol: 'USDT', name: 'Tether',
      swappable: swap,
      availability: { status: 'swappable', providers: ['relay'] },
    })
    expect(bucketFor(e)).toBe(3)
  })

  test('matrix-swappable native (no Pioneer entry) → bucket 4', () => {
    const e = entry({
      caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0',
      symbol: 'BTC', name: 'Bitcoin',
      availability: { status: 'swappable', providers: ['thorchain'] },
    })
    expect(bucketFor(e)).toBe(4)
  })

  test('matrix-swappable token (no Pioneer entry) → bucket 5', () => {
    const e = entry({
      caip: 'eip155:1/erc20:0xdeadbeef', symbol: 'X', name: 'Stablecoin',
      isNative: false,
      availability: { status: 'swappable', providers: ['relay'] },
    })
    expect(bucketFor(e)).toBe(5)
  })

  test('matrix-unknown (try a quote) → bucket 6', () => {
    const e = entry({
      caip: 'eip155:1/erc20:0x1234', symbol: 'PEPE', name: 'Pepe',
      isNative: false,
      availability: { status: 'unknown', providers: [] },
    })
    expect(bucketFor(e)).toBe(6)
  })

  test('unsupported_chain → bucket 7', () => {
    const e = entry({
      caip: 'tron:27Lqcw/slip44:195', symbol: 'TRX', name: 'TRON',
      availability: { status: 'unsupported_chain', providers: [] },
    })
    expect(bucketFor(e)).toBe(7)
  })
})

describe('compareEntries — empty-query bucket sort', () => {
  test('held + USD desc beats Pioneer-swappable not-held', () => {
    const held = entry({
      caip: 'eip155:1/slip44:60', symbol: 'ETH', name: 'Ethereum',
      balance: { amount: '1', usd: 3000 },
      availability: { status: 'swappable', providers: ['relay'] },
    })
    const swappable = entry({
      caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0',
      symbol: 'BTC', name: 'Bitcoin',
      swappable: { asset: 'BTC.BTC' } as any,
      availability: { status: 'swappable', providers: ['thorchain'] },
    })
    expect(compareEntries(held, swappable)).toBeLessThan(0)
  })

  test('within bucket 0: highest USD first', () => {
    const a = entry({ caip: 'a', symbol: 'A', name: 'A', balance: { amount: '1', usd: 100 } })
    const b = entry({ caip: 'b', symbol: 'B', name: 'B', balance: { amount: '1', usd: 5000 } })
    expect(compareEntries(a, b)).toBeGreaterThan(0)
  })

  test('non-bucket-0 ties break alphabetically by symbol', () => {
    const a = entry({ caip: 'a', symbol: 'BBB', name: 'Beta', availability: { status: 'unknown', providers: [] } })
    const b = entry({ caip: 'b', symbol: 'AAA', name: 'Alpha', availability: { status: 'unknown', providers: [] } })
    expect(compareEntries(a, b)).toBeGreaterThan(0)
  })
})

describe('searchEntries — composite score', () => {
  // The "bitcoin" UX bug we explicitly designed against: a memecoin with
  // symbol "BITCOIN" must NOT outrank actual BTC when the user types "bitcoin".
  const realBTC = entry({
    caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0',
    symbol: 'BTC', name: 'Bitcoin',
    availability: { status: 'swappable', providers: ['thorchain'] },
  })
  const memecoin = entry({
    caip: 'eip155:56/erc20:0xMEME', symbol: 'BITCOIN', name: 'BITCOIN Memecoin',
    isNative: false,
    availability: { status: 'unknown', providers: [] },
  })
  const trx = entry({
    caip: 'tron:27Lqcw/slip44:195', symbol: 'TRX', name: 'TRON',
    availability: { status: 'unsupported_chain', providers: [] },
  })
  const tronToken = entry({
    caip: 'eip155:1/erc20:0xTRONISH', symbol: 'TRONISH', name: 'Tron Imitation',
    isNative: false,
    availability: { status: 'unknown', providers: [] },
  })

  test('"bitcoin" → real BTC first (name match, swappable bucket)', () => {
    const idx = buildSearchIndex([memecoin, realBTC])
    const r = searchEntries(idx, 'bitcoin')
    expect(r[0].symbol).toBe('BTC')
    expect(r[1].symbol).toBe('BITCOIN')
  })

  test('"BITCOIN" (uppercase) → real BTC first (case-insensitive)', () => {
    const idx = buildSearchIndex([memecoin, realBTC])
    const r = searchEntries(idx, 'BITCOIN')
    expect(r[0].symbol).toBe('BTC')
  })

  test('"tron" → TRX first even when unsupported (rank 0 trumps neighbor bucket)', () => {
    // matchRank 0 + bucket 7 = 7. TRONISH is rank 1 (prefix) + bucket 6 = 16.
    // TRX wins despite being in the worst bucket.
    const idx = buildSearchIndex([tronToken, trx])
    const r = searchEntries(idx, 'tron')
    expect(r[0].symbol).toBe('TRX')
    expect(r[1].symbol).toBe('TRONISH')
  })

  test('"btc" exact-symbol → real BTC over substring matches', () => {
    const wbtc = entry({
      caip: 'eip155:1/erc20:0xWBTC', symbol: 'WBTC', name: 'Wrapped BTC',
      isNative: false,
      availability: { status: 'unknown', providers: [] },
    })
    const idx = buildSearchIndex([wbtc, realBTC])
    const r = searchEntries(idx, 'btc')
    expect(r[0].symbol).toBe('BTC')
  })

  test('empty query returns input unchanged', () => {
    const idx = buildSearchIndex([realBTC, memecoin])
    expect(searchEntries(idx, '')).toEqual([realBTC, memecoin])
    expect(searchEntries(idx, '   ')).toEqual([realBTC, memecoin])
  })

  test('CAIP substring match works', () => {
    const idx = buildSearchIndex([realBTC, memecoin])
    const r = searchEntries(idx, 'bip122')
    expect(r.length).toBe(1)
    expect(r[0].symbol).toBe('BTC')
  })

  test('no match → empty array', () => {
    const idx = buildSearchIndex([realBTC, memecoin])
    expect(searchEntries(idx, 'nonexistent_zzz')).toEqual([])
  })
})

describe('chainMetaForCaip2', () => {
  test('Bitcoin CAIP-2 resolves to chain meta with full native CAIP', () => {
    const meta = chainMetaForCaip2('bip122:000000000019d6689c085ae165831e93')
    expect(meta).not.toBeNull()
    // The native CAIP-19 must include the slip44 segment — that's what
    // AssetIcon's caipToIcon expects (CAIP-2 alone produces a wrong URL).
    expect(meta!.nativeCaip).toContain('/slip44:')
    expect(meta!.vaultChainId).toBe('bitcoin')
    expect(meta!.chainFamily).toBe('utxo')
  })

  test('Ethereum CAIP-2 resolves correctly', () => {
    const meta = chainMetaForCaip2('eip155:1')
    expect(meta).not.toBeNull()
    expect(meta!.vaultChainId).toBe('ethereum')
    expect(meta!.nativeCaip).toBe('eip155:1/slip44:60')
    expect(meta!.chainFamily).toBe('evm')
  })

  test('unknown CAIP-2 returns null (e.g. Monad-like)', () => {
    expect(chainMetaForCaip2('eip155:99999')).toBeNull()
  })
})

describe('synthesizeSwapAsset', () => {
  // Synthesis is what fires when the user picks a row Pioneer didn't include
  // in GetAvailableAssets. Downstream quote/execute code is shaped around
  // SwapAsset; this helper has to produce a valid one or refuse cleanly.

  test('native EVM asset → synthesized SwapAsset with full caip + no contract', () => {
    const e = entry({
      caip: 'eip155:1/slip44:60', symbol: 'ETH', name: 'Ethereum',
      chainId: 'eip155:1',
      availability: { status: 'swappable', providers: ['relay'] },
    })
    const s = synthesizeSwapAsset(e)
    expect(s).not.toBeNull()
    expect(s!.caip).toBe('eip155:1/slip44:60')
    expect(s!.contractAddress).toBeUndefined()
    expect(s!.chainId).toBe('ethereum')      // vault internal id
    expect(s!.chainFamily).toBe('evm')
    expect(s!.symbol).toBe('ETH')
    expect(s!.asset).toMatch(/^[A-Z]+\.ETH$/)
  })

  test('ERC-20 token → contract address parsed out of the caip', () => {
    const e = entry({
      caip: 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7',
      symbol: 'USDT', name: 'Tether',
      chainId: 'eip155:1',
      isNative: false,
      availability: { status: 'swappable', providers: ['relay', 'zeroex'] },
    })
    const s = synthesizeSwapAsset(e)
    expect(s).not.toBeNull()
    expect(s!.contractAddress).toBe('0xdac17f958d2ee523a2206206994597c13d831ec7')
    expect(s!.caip).toBe(e.caip)
    expect(s!.asset).toContain('USDT')
    expect(s!.asset.toUpperCase()).toContain('0XDAC17F958D2EE523A2206206994597C13D831EC7')
  })

  test('Bitcoin native → utxo family + synthetic THORChain-style asset', () => {
    const e = entry({
      caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0',
      symbol: 'BTC', name: 'Bitcoin',
      chainId: 'bip122:000000000019d6689c085ae165831e93',
      availability: { status: 'swappable', providers: ['thorchain'] },
    })
    const s = synthesizeSwapAsset(e)
    expect(s).not.toBeNull()
    expect(s!.chainFamily).toBe('utxo')
    expect(s!.chainId).toBe('bitcoin')
  })

  test('unknown chain → returns null (caller should refuse the click)', () => {
    const e = entry({
      caip: 'eip155:99999/erc20:0xfoo', symbol: 'X', name: 'Y',
      chainId: 'eip155:99999',
      availability: { status: 'unknown', providers: [] },
    })
    expect(synthesizeSwapAsset(e)).toBeNull()
  })

  test('TRON token (alternate base58 encoding) resolves to vault chain meta', () => {
    // pioneer-discovery emits tron:27Lqcw (base58 of the genesis hash) while
    // vault's CHAINS table stores tron:0x2b6653dc (hex). The alias table in
    // getChainMetaMap aliases both encodings to the same ChainMeta so synthesis
    // succeeds — earlier this returned null and the user saw TRON USDT as
    // unselectable in the picker.
    const e = entry({
      caip: 'tron:27Lqcw/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      symbol: 'USDT', name: 'Tether',
      chainId: 'tron:27Lqcw',
      isNative: false,
      availability: { status: 'swappable', providers: ['thorchain'] },
    })
    const s = synthesizeSwapAsset(e)
    expect(s).not.toBeNull()
    expect(s!.chainId).toBe('tron')
    expect(s!.contractAddress).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
  })
})

describe('canonicalizeChainCaip2 / canonicalizeCaip', () => {
  // The TRON 3-row regression: pioneer-discovery emits tron:27Lqcw,
  // tron:27lqcw, AND tron:0x2b6653dc — without canonicalization the picker
  // shows three TRX entries, two of them disabled. Pin the alias resolution
  // so a future matrix edit can't silently fragment the picker again.
  test('TRON base58 (mixed-case) → hex canonical', () => {
    expect(canonicalizeChainCaip2('tron:27Lqcw')).toBe('tron:0x2b6653dc')
    expect(canonicalizeChainCaip2('tron:27lqcw')).toBe('tron:0x2b6653dc')
  })

  test('Hyperliquid pioneer-discovery encoding (eip155:2868) → Relay-canonical (eip155:999)', () => {
    expect(canonicalizeChainCaip2('eip155:2868')).toBe('eip155:999')
  })

  test('canonical encodings pass through unchanged', () => {
    expect(canonicalizeChainCaip2('eip155:1')).toBe('eip155:1')
    expect(canonicalizeChainCaip2('tron:0x2b6653dc')).toBe('tron:0x2b6653dc')
  })

  test('canonicalizeCaip rewrites only the chain prefix, preserves the rest', () => {
    expect(canonicalizeCaip('tron:27Lqcw/slip44:195'))
      .toBe('tron:0x2b6653dc/slip44:195')
    expect(canonicalizeCaip('tron:27lqcw/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'))
      .toBe('tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
    expect(canonicalizeCaip('eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7'))
      .toBe('eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7')  // already canonical
  })

  test('chain-only CAIP-2 (no slash) still aliases', () => {
    expect(canonicalizeCaip('tron:27Lqcw')).toBe('tron:0x2b6653dc')
    expect(canonicalizeCaip('eip155:2868')).toBe('eip155:999')
  })
})
