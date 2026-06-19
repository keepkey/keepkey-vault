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
  parseCaip,
  synthesizeSwapAsset,
  compareForPicker,
  pickerTier,
  isStablecoinEntry,
  isJunkEntry,
  assessWithFirmware,
  ellipsizeCaip,
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
    discoveryRank: partial.discoveryRank,
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

describe('ellipsizeCaip — middle-ellipsis only on long hex/base58 parts', () => {
  test('shortens the erc20 contract, keeps eip155:1/erc20: prefix intact', () => {
    expect(ellipsizeCaip('eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'))
      .toBe('eip155:1/erc20:0xa0b869…06eb48')
  })
  test('shortens the bip122 genesis hash, keeps slip44 index', () => {
    expect(ellipsizeCaip('bip122:000000000019d6689c085ae165831e93/slip44:0'))
      .toBe('bip122:000000…831e93/slip44:0')
  })
  test('leaves short references (chain id, slip44) untouched', () => {
    expect(ellipsizeCaip('eip155:1/slip44:60')).toBe('eip155:1/slip44:60')
  })
  test('never chops across a delimiter', () => {
    const out = ellipsizeCaip('eip155:10/erc20:0x0b2c639c533813f4aa9d7837caf62653d097ff85')
    expect(out.startsWith('eip155:10/erc20:0x')).toBe(true)
  })
  test('empty string is a no-op', () => {
    expect(ellipsizeCaip('')).toBe('')
  })
})

describe('picker ordering — stables → popularity → junk last', () => {
  const sol = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
  const tok = (sym: string, name: string, rank: number | undefined, extra: Partial<AssetEntry> = {}) =>
    entry({
      caip: `${sol}/token:${sym}MINT`, symbol: sym, name,
      chainId: sol, isNative: false, discoveryRank: rank,
      availability: { status: 'unknown', providers: [] },
      ...extra,
    })

  describe('isStablecoinEntry', () => {
    test('curated symbol set (USDT/USDC/USDS…)', () => {
      expect(isStablecoinEntry(tok('USDT', 'Tether', 0))).toBe(true)
      expect(isStablecoinEntry(tok('USDC', 'USD Coin', 1))).toBe(true)
      expect(isStablecoinEntry(tok('PYUSD', 'PayPal USD', 5))).toBe(true)
    })
    test('non-curated USD-named tokens are NOT promoted (curated set only)', () => {
      // The earlier broad name heuristic matched ~800 tokens and floated junk
      // like these above SOL/LINK — now only the curated set counts.
      expect(isStablecoinEntry(tok('USDUC', 'Unstable Coin', 9))).toBe(false)
      expect(isStablecoinEntry(tok('USDUT', 'Unstable Tether', 9))).toBe(false)
      expect(isStablecoinEntry(tok('GGUSD', 'Good Game US Dollar', 9))).toBe(false)
    })
    test('non-stables stay false', () => {
      expect(isStablecoinEntry(tok('LINK', 'Chainlink', 2))).toBe(false)
      expect(isStablecoinEntry(tok('BONK', 'Bonk', 18))).toBe(false)
    })
    test('native assets are never stablecoins (even SOL)', () => {
      const native = entry({ caip: `${sol}/slip44:501`, symbol: 'SOL', name: 'Solana', chainId: sol })
      expect(isStablecoinEntry(native)).toBe(false)
    })
  })

  describe('isJunkEntry', () => {
    test('absurdly long ticker → junk', () => {
      expect(isJunkEntry(tok('SUPERLONGTICKER1', 'Whatever', 999))).toBe(true)
    })
    test('spammy name → junk', () => {
      expect(isJunkEntry(tok('FREE', 'just buy 1 of this coin', 4000))).toBe(true)
      expect(isJunkEntry(tok('AIR', 'Free airdrop claim t.me/scam', 4001))).toBe(true)
    })
    test('plain low-rank token is NOT junk (relies on rank to sink it)', () => {
      expect(isJunkEntry(tok('000', '000 Capital', 5000))).toBe(false)
    })
    test('held tokens are never junk', () => {
      expect(isJunkEntry(tok('SUPERLONGTICKER1', 'x', 1, { balance: { amount: '1', usd: 0 } }))).toBe(false)
    })
  })

  const nativeSol = (rank?: number) => entry({
    caip: `${sol}/slip44:501`, symbol: 'SOL', name: 'Solana', chainId: sol, isNative: true,
    availability: { status: 'swappable', providers: ['thorchain'] }, discoveryRank: rank,
  })

  describe('pickerTier', () => {
    test('held(value)=0, held(no price)=1, gas/native=2, USDC/USDT=3, other stable=4, normal=5, junk=6, unsupported=7', () => {
      expect(pickerTier(tok('USDC', 'USD Coin', 1, { balance: { amount: '5', usd: 5 } }))).toBe(0)
      expect(pickerTier(tok('WUT', 'Wut', 9, { balance: { amount: '5', usd: 0 } }))).toBe(1)
      expect(pickerTier(nativeSol(30))).toBe(2)                  // gas/native leads swappable
      expect(pickerTier(tok('USDT', 'Tether', 0))).toBe(3)       // priority stable
      expect(pickerTier(tok('USDC', 'USD Coin', 1))).toBe(3)     // priority stable
      expect(pickerTier(tok('PYUSD', 'PayPal USD', 5))).toBe(4)  // other stable
      expect(pickerTier(tok('LINK', 'Chainlink', 2))).toBe(5)
      expect(pickerTier(tok('AIR', 'free airdrop claim', 4000))).toBe(6)
      expect(pickerTier(tok('X', 'Unsupported', 7, {
        availability: { status: 'unsupported_token', providers: [] },
      }))).toBe(7)
    })
  })

  test('end-to-end: USDT/stables lead, popular by rank, "000" sinks below them', () => {
    const list = [
      tok('000', '000 Capital', 5000),
      tok('BONK', 'Bonk', 18),
      tok('USDT', 'Tether', 0),
      tok('LINK', 'Chainlink', 2),
      tok('USDC', 'USD Coin', 1),
    ]
    const sorted = [...list].sort(compareForPicker).map(e => e.symbol)
    // stables first (USDT before USDC by rank), then popular by rank, "000" last
    expect(sorted).toEqual(['USDT', 'USDC', 'LINK', 'BONK', '000'])
  })

  test('gas/native leads, then USDC/USDT, then tokens; obscure USD-named tokens are NOT promoted', () => {
    // Gas asset (SOL) now leads the swappable section, then the priority
    // stable (USDT), then popular tokens by rank — and a non-curated "USD…"
    // memecoin must sink to the long tail, not jump above SOL/LINK.
    const list = [
      tok('LINK', 'Chainlink', 2),
      tok('USDUT', 'Unstable Tether', 8000),  // non-curated → normal tier, high rank
      nativeSol(50),
      tok('USDT', 'Tether', 0),
    ]
    const sorted = [...list].sort(compareForPicker).map(e => e.symbol)
    expect(sorted).toEqual(['SOL', 'USDT', 'LINK', 'USDUT'])
  })

  test('USDC/USDT lead the broad stablecoin list', () => {
    // The two stables users reach for most sit above uncommon stables.
    const list = [
      tok('PYUSD', 'PayPal USD', 3),   // other stable
      tok('USDC', 'USD Coin', 50),
      tok('DAI', 'Dai', 4),            // other stable
      tok('USDT', 'Tether', 60),
      nativeSol(50),
    ]
    const sorted = [...list].sort(compareForPicker).map(e => e.symbol)
    // gas first, then USDC/USDT (by rank), then other stables (by rank)
    expect(sorted).toEqual(['SOL', 'USDC', 'USDT', 'PYUSD', 'DAI'])
  })

  test('held assets outrank stablecoins regardless of value', () => {
    const heldSol = entry({
      caip: `${sol}/slip44:501`, symbol: 'SOL', name: 'Solana', chainId: sol,
      balance: { amount: '1', usd: 200 },
      availability: { status: 'swappable', providers: ['thorchain'] },
    })
    const usdt = tok('USDT', 'Tether', 0)
    expect(compareForPicker(heldSol, usdt)).toBeLessThan(0)
  })

  test('within priority-stable tier, lower discoveryRank wins; undefined rank sinks', () => {
    const usdt = tok('USDT', 'Tether', 0)
    const noRank = tok('USDC', 'USD Coin', undefined)
    expect(compareForPicker(usdt, noRank)).toBeLessThan(0)
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

  test('Hyperliquid is intentionally NOT aliased', () => {
    // The 2868 vs 999 mismatch between vault CHAINS and chainID.network
    // is unresolved. Aliasing 2868→999 would let the picker show Hyperliquid
    // as swappable, but vault's ChainDef sits at 2868 (with a non-mainnet
    // chainId) so click would silently fail in the synthesizer. Until the
    // upstream is reconciled, both encodings pass through and Hyperliquid
    // shows in the picker as unsupported_chain with a clear reason.
    expect(canonicalizeChainCaip2('eip155:2868')).toBe('eip155:2868')
    expect(canonicalizeChainCaip2('eip155:999')).toBe('eip155:999')
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
  })

  test('BSC token namespace folds /bep20: → /erc20: at canonicalization', () => {
    // Outgoing CAIP that goes to Pioneer Quote must be /erc20: — pioneer-server
    // returns "No quotes available" for /bep20: BSC USDT. Folding here means
    // the picker, matrix lookup, and quote call all see the same form.
    expect(canonicalizeCaip('eip155:56/bep20:0x55d398326f99059ff775485246999027b3197955'))
      .toBe('eip155:56/erc20:0x55d398326f99059ff775485246999027b3197955')
    // /erc20: pass-through (already canonical).
    expect(canonicalizeCaip('eip155:56/erc20:0x55d398326f99059ff775485246999027b3197955'))
      .toBe('eip155:56/erc20:0x55d398326f99059ff775485246999027b3197955')
    // Other chains' bep20-look-alike namespaces are NOT touched (unlikely but
    // defensive — bep20 only exists on BSC).
    expect(canonicalizeCaip('eip155:1/bep20:0xfoo')).toBe('eip155:1/bep20:0xfoo')
  })
})

describe('parseCaip — single source for namespace classification', () => {
  // Earlier homemade isNative checks excluded `/erc20:` and `/token:` but
  // missed `/bep20:` — pioneer-discovery emits BSC tokens under that namespace.
  // The picker classified BSC tokens as native, the synthesizer dropped their
  // contractAddress, and the dialog showed native BNB pricing for them.
  test('ERC-20 → token + contract address preserved', () => {
    const r = parseCaip('eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7')
    expect(r.isToken).toBe(true)
    expect(r.contractAddress).toBe('0xdac17f958d2ee523a2206206994597c13d831ec7')
    expect(r.chainCaip2).toBe('eip155:1')
  })

  test('BEP-20 → token + contract address preserved (was the bug)', () => {
    const r = parseCaip('eip155:56/bep20:0x55d398326f99059ff775485246999027b3197955')
    expect(r.isToken).toBe(true)
    expect(r.contractAddress).toBe('0x55d398326f99059ff775485246999027b3197955')
  })

  test('TRON token namespace (case-sensitive contract) → preserved as-is', () => {
    const r = parseCaip('tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
    expect(r.isToken).toBe(true)
    // Contract case must be preserved — base58 is case-sensitive on TRON.
    expect(r.contractAddress).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
  })

  test('Native chain (slip44) → not a token', () => {
    expect(parseCaip('eip155:1/slip44:60').isToken).toBe(false)
    expect(parseCaip('bip122:000000000019d6689c085ae165831e93/slip44:0').isToken).toBe(false)
  })

  test('Chain-only (no namespace) → not a token', () => {
    expect(parseCaip('eip155:1').isToken).toBe(false)
  })
})

describe('synthesizeSwapAsset — BEP-20 contract is preserved (regression)', () => {
  test('BSC USDT (bep20 namespace) keeps contract address', () => {
    const e = entry({
      caip: 'eip155:56/bep20:0x55d398326f99059ff775485246999027b3197955',
      symbol: 'USDT', name: 'Tether',
      chainId: 'eip155:56',
      isNative: false,
      availability: { status: 'swappable', providers: ['relay'] },
    })
    const s = synthesizeSwapAsset(e)
    expect(s).not.toBeNull()
    expect(s!.contractAddress).toBe('0x55d398326f99059ff775485246999027b3197955')
    // Synthesized asset string also gets the contract via THORChain convention.
    expect(s!.asset).toContain('-0X55D398326F99059FF775485246999027B3197955')
    expect(s!.chainId).toBe('bsc')
  })
})

describe('assessWithFirmware — gates provider-routable chains by device firmware', () => {
  // ZEC native: Mayachain pools it, but Zcash signing/derivation needs fw 7.15.0.
  const ZEC = 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
  // SOL native: routed by THORChain/ShapeShift/ChainFlip, needs fw 7.14.0.
  const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501'
  // BTC native: no minFirmware — always swappable.
  const BTC = 'bip122:000000000019d6689c085ae165831e93/slip44:0'

  test('ZEC is swappable only on firmware >= 7.15.0', () => {
    expect(assessWithFirmware(ZEC, '7.15.0').status).toBe('swappable')
    expect(assessWithFirmware(ZEC, '7.16.0').status).toBe('swappable')
  })

  test('ZEC is unsupported_firmware on older firmware', () => {
    const a = assessWithFirmware(ZEC, '7.14.1')
    expect(a.status).toBe('unsupported_firmware')
    expect(a.providers).toEqual([])
    expect(a.reason).toContain('7.15.0')
  })

  test('ZEC is gated (fail closed) when firmware version is unknown', () => {
    expect(assessWithFirmware(ZEC, undefined).status).toBe('unsupported_firmware')
  })

  test('SOL is gated below 7.14.0 and allowed at/above it', () => {
    expect(assessWithFirmware(SOL, '7.13.0').status).toBe('unsupported_firmware')
    expect(assessWithFirmware(SOL, '7.14.0').status).toBe('swappable')
  })

  test('chains without a minFirmware are unaffected by firmware', () => {
    expect(assessWithFirmware(BTC, undefined).status).toBe('swappable')
    expect(assessWithFirmware(BTC, '7.0.0').status).toBe('swappable')
  })

  test('a chain no provider routes stays unsupported_chain regardless of firmware', () => {
    // Fantom (eip155:250) is in none of the provider sets.
    const FTM = 'eip155:250/slip44:60'
    expect(assessWithFirmware(FTM, '7.15.0').status).toBe('unsupported_chain')
    expect(assessWithFirmware(FTM, undefined).status).toBe('unsupported_chain')
  })
})

describe('pickerTier / bucketFor — firmware-gated assets sink and are not selectable', () => {
  const gated = entry({
    caip: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
    symbol: 'ZEC', name: 'Zcash', isNative: true,
    availability: { status: 'unsupported_firmware', providers: [], reason: 'update fw' },
  })

  test('unsupported_firmware lands in the unsupported buckets', () => {
    expect(bucketFor(gated)).toBe(7)
    expect(pickerTier(gated)).toBe(7)
  })

  test('Pioneer-listed but firmware-gated still sinks (swappable does not override the gate)', () => {
    // Mayachain pools ZEC, so Pioneer's GetAvailableAssets can include it —
    // entry.swappable is set. bucketFor must NOT float it into the
    // Pioneer-confirmed buckets (2/3) while it's unselectable.
    const pioneerGated = {
      ...gated,
      swappable: { asset: 'ZEC.ZEC', chainId: 'zcash', symbol: 'ZEC', name: 'Zcash', chainFamily: 'utxo', decimals: 8 } as any,
      swappableAsset: 'ZEC.ZEC',
    }
    expect(bucketFor(pioneerGated)).toBe(7)
    expect(pickerTier(pioneerGated)).toBe(7)
  })

  test('held firmware-gated asset still ranks by holdings, not buried', () => {
    const heldGated = { ...gated, balance: { amount: '1.0', usd: 100 } }
    expect(bucketFor(heldGated)).toBe(0)
    expect(pickerTier(heldGated)).toBe(0)
  })
})
