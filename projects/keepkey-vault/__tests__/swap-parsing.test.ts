/**
 * Tests for Pioneer SDK response parsing in swap.ts
 *
 * These test the pure parsing functions (parseQuoteResponse, parseAssetsResponse)
 * against real Pioneer response fixtures to catch field extraction regressions.
 *
 * Run: bun test __tests__/swap-parsing.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { parseQuoteResponse, parseAssetsResponse } from '../src/bun/swap-parsing'

// ── Fixtures: Real Pioneer SDK response shapes ──────────────────────

/** BASE → ETH swap via Pioneer (THORChain integration) */
const FIXTURE_BASE_TO_ETH_QUOTE = {
  data: {
    success: true,
    data: [{
      integration: 'thorchain',
      quote: {
        buyAmount: '0.00245',
        amountOutMin: '0.00238',
        inbound_address: null,
        router: null,
        memo: null,
        raw: {
          inbound_address: '0xabc123vault',
          router: '0x1b3e6daa08e7a2e29e2ff23b6c40abe79a15a17a',
          expected_amount_out: '0.00245',
          expiry: 1710000000,
          fees: {
            total_bps: 150,
            outbound: '0.0001',
            affiliate: '0.00005',
            slippage_bps: 42,
          },
          warning: 'Streaming swap: may take longer',
          inbound_confirmation_seconds: 120,
        },
        txs: [{
          txParams: {
            memo: '=:ETH.ETH:0xdest123:245000/3/0:kk:0',
            recipientAddress: '0x1b3e6daa08e7a2e29e2ff23b6c40abe79a15a17a',
            vaultAddress: '0xabc123vault',
          },
        }],
      },
    }],
  },
}

/** BTC → ETH swap — Pioneer wraps THORNode data differently */
const FIXTURE_BTC_TO_ETH_QUOTE = {
  data: [{
    integration: 'thorchain',
    quote: {
      buyAmount: '1.25',
      raw: {
        inbound_address: 'bc1qvaultaddress',
        router: undefined,
        expected_amount_out: '1.25',
        expiry: 0,
        fees: {
          total_bps: 200,
          outbound: '0.001',
          affiliate: '0',
          slippage_bps: 85,
        },
        total_swap_seconds: 900,
      },
      txs: [{
        txParams: {
          memo: '=:ETH.ETH:0xdest456:125000',
          vaultAddress: 'bc1qvaultaddress',
        },
      }],
    },
  }],
}

/** Minimal quote response — fields at top level, no raw/txs nesting */
const FIXTURE_MINIMAL_QUOTE = {
  data: {
    data: [{
      integration: 'shapeshift',
      quote: {
        buyAmount: '500',
        memo: 'swap:ETH.ETH:0xdest',
        inbound_address: '0xvault789',
        router: '0xrouter789',
        expiry: 1710000001,
        fees: {
          totalBps: 100,
          outbound: '0.05',
          affiliate: '0.01',
          slippageBps: 50,
        },
        estimatedTime: 300,
      },
    }],
  },
}

/** Quote response where data is a single object, not array */
const FIXTURE_SINGLE_QUOTE = {
  data: {
    integration: 'chainflip',
    quote: {
      buyAmount: '0.5',
      inbound_address: '0xsingle_vault',
      memo: 'cf:swap',
      fees: {
        totalBps: 75,
        outbound: '0.002',
        affiliate: '0',
      },
      estimatedTime: 180,
    },
  },
}

/** Assets response from Pioneer GetAvailableAssets */
const FIXTURE_ASSETS_RESPONSE = {
  data: {
    success: true,
    data: {
      assets: [
        { asset: 'BTC.BTC', symbol: 'BTC', name: 'Bitcoin', decimals: 8 },
        { asset: 'ETH.ETH', symbol: 'ETH', name: 'Ethereum', decimals: 18 },
        { asset: 'ETH.USDT-0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
        { asset: 'GAIA.ATOM', symbol: 'ATOM', name: 'Cosmos Hub', decimals: 6 },
        { asset: 'BASE.ETH', symbol: 'ETH', name: 'Base ETH', decimals: 18 },
        { asset: 'UNKNOWN.FOO', symbol: 'FOO' }, // unknown chain — should be filtered out
      ],
    },
  },
}

/** Assets response with flat array (no wrapper) */
const FIXTURE_ASSETS_FLAT = {
  data: [
    { asset: 'BTC.BTC', symbol: 'BTC', name: 'Bitcoin' },
    { asset: 'ETH.ETH', symbol: 'ETH', name: 'Ethereum' },
  ],
}

// ── Quote parsing tests ─────────────────────────────────────────────

describe('parseQuoteResponse', () => {
  const baseParams = { fromAsset: 'BASE.ETH', toAsset: 'ETH.ETH', slippageBps: 300 }

  test('BASE → ETH: extracts memo from txParams', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.memo).toBe('=:ETH.ETH:0xdest123:245000/3/0:kk:0')
  })

  test('BASE → ETH: extracts router from raw', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.router).toBe('0x1b3e6daa08e7a2e29e2ff23b6c40abe79a15a17a')
  })

  test('BASE → ETH: extracts inboundAddress from raw', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.inboundAddress).toBe('0xabc123vault')
  })

  test('BASE → ETH: extracts expiry from raw', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.expiry).toBe(1710000000)
  })

  test('BASE → ETH: extracts expectedOutput', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.expectedOutput).toBe('0.00245')
  })

  test('BASE → ETH: extracts fees from raw.fees', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.fees.totalBps).toBe(150)
    expect(result.fees.outbound).toBe('0.0001')
    expect(result.fees.affiliate).toBe('0.00005')
  })

  test('BASE → ETH: extracts slippageBps from raw.fees', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.slippageBps).toBe(42)
  })

  test('BASE → ETH: extracts warning from raw', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.warning).toBe('Streaming swap: may take longer')
  })

  test('BASE → ETH: extracts estimatedTime from raw', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.estimatedTime).toBe(120)
  })

  test('BASE → ETH: extracts integration', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.integration).toBe('thorchain')
  })

  test('BASE → ETH: minimumOutput from amountOutMin', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.minimumOutput).toBe('0.00238')
  })

  test('BASE → ETH: preserves fromAsset/toAsset from params', () => {
    const result = parseQuoteResponse(FIXTURE_BASE_TO_ETH_QUOTE, baseParams)
    expect(result.fromAsset).toBe('BASE.ETH')
    expect(result.toAsset).toBe('ETH.ETH')
  })

  // BTC → ETH (no router, memo in txParams)
  test('BTC → ETH: extracts memo from txParams', () => {
    const params = { fromAsset: 'BTC.BTC', toAsset: 'ETH.ETH', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_BTC_TO_ETH_QUOTE, params)
    expect(result.memo).toBe('=:ETH.ETH:0xdest456:125000')
  })

  test('BTC → ETH: inboundAddress from txParams.vaultAddress', () => {
    const params = { fromAsset: 'BTC.BTC', toAsset: 'ETH.ETH', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_BTC_TO_ETH_QUOTE, params)
    expect(result.inboundAddress).toBe('bc1qvaultaddress')
  })

  test('BTC → ETH: router is undefined (UTXO chains have no router)', () => {
    const params = { fromAsset: 'BTC.BTC', toAsset: 'ETH.ETH', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_BTC_TO_ETH_QUOTE, params)
    expect(result.router).toBeUndefined()
  })

  test('BTC → ETH: estimatedTime from raw.total_swap_seconds', () => {
    const params = { fromAsset: 'BTC.BTC', toAsset: 'ETH.ETH', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_BTC_TO_ETH_QUOTE, params)
    expect(result.estimatedTime).toBe(900)
  })

  test('BTC → ETH: minimumOutput calculated from slippage when no amountOutMin', () => {
    const params = { fromAsset: 'BTC.BTC', toAsset: 'ETH.ETH', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_BTC_TO_ETH_QUOTE, params)
    // 1.25 * (1 - 85/10000) = 1.25 * 0.9915 = 1.239375
    expect(parseFloat(result.minimumOutput)).toBeCloseTo(1.239375, 4)
  })

  // Minimal response (fields at top-level quote, no raw/txs)
  test('minimal: extracts fields from top-level quote properties', () => {
    const params = { fromAsset: 'ETH.ETH', toAsset: 'BTC.BTC', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_MINIMAL_QUOTE, params)
    expect(result.memo).toBe('swap:ETH.ETH:0xdest')
    expect(result.inboundAddress).toBe('0xvault789')
    expect(result.router).toBe('0xrouter789')
    expect(result.expiry).toBe(1710000001)
    expect(result.expectedOutput).toBe('500')
    expect(result.estimatedTime).toBe(300)
    expect(result.integration).toBe('shapeshift')
  })

  // Single object (not array)
  test('single object response: wraps in array and parses', () => {
    const params = { fromAsset: 'ETH.ETH', toAsset: 'BTC.BTC', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_SINGLE_QUOTE, params)
    expect(result.expectedOutput).toBe('0.5')
    expect(result.memo).toBe('cf:swap')
    expect(result.inboundAddress).toBe('0xsingle_vault')
    expect(result.integration).toBe('chainflip')
  })

  // Error cases
  test('throws on empty response', () => {
    expect(() => parseQuoteResponse(null, baseParams))
      .toThrow('Pioneer Quote returned empty response')
  })

  test('throws on missing output amount', () => {
    const badResp = { data: [{ quote: { inbound_address: '0x123' } }] }
    expect(() => parseQuoteResponse(badResp, baseParams))
      .toThrow('Quote response missing output amount')
  })

  test('throws on missing inbound address', () => {
    const badResp = { data: [{ quote: { buyAmount: '1.0' } }] }
    expect(() => parseQuoteResponse(badResp, baseParams))
      .toThrow('Quote response missing inbound address')
  })
})

// ── Assets parsing tests ────────────────────────────────────────────

describe('parseAssetsResponse', () => {
  test('parses double-wrapped response with assets array', () => {
    const assets = parseAssetsResponse(FIXTURE_ASSETS_RESPONSE)
    expect(assets.length).toBe(5) // 5 known chains, 1 unknown filtered
  })

  test('maps BTC.BTC to bitcoin chain', () => {
    const assets = parseAssetsResponse(FIXTURE_ASSETS_RESPONSE)
    const btc = assets.find(a => a.asset === 'BTC.BTC')
    expect(btc).toBeTruthy()
    expect(btc!.chainId).toBe('bitcoin')
    expect(btc!.symbol).toBe('BTC')
    expect(btc!.chainFamily).toBe('utxo')
  })

  test('maps ETH.ETH to ethereum chain', () => {
    const assets = parseAssetsResponse(FIXTURE_ASSETS_RESPONSE)
    const eth = assets.find(a => a.asset === 'ETH.ETH')
    expect(eth).toBeTruthy()
    expect(eth!.chainId).toBe('ethereum')
    expect(eth!.chainFamily).toBe('evm')
  })

  test('extracts ERC-20 contract address', () => {
    const assets = parseAssetsResponse(FIXTURE_ASSETS_RESPONSE)
    const usdt = assets.find(a => a.asset.startsWith('ETH.USDT'))
    expect(usdt).toBeTruthy()
    expect(usdt!.contractAddress).toBe('0xdAC17F958D2ee523a2206206994597C13D831ec7')
    expect(usdt!.decimals).toBe(6)
  })

  test('maps GAIA.ATOM to cosmos chain', () => {
    const assets = parseAssetsResponse(FIXTURE_ASSETS_RESPONSE)
    const atom = assets.find(a => a.asset === 'GAIA.ATOM')
    expect(atom).toBeTruthy()
    expect(atom!.chainId).toBe('cosmos')
    expect(atom!.chainFamily).toBe('cosmos')
  })

  test('maps BASE.ETH to base chain', () => {
    const assets = parseAssetsResponse(FIXTURE_ASSETS_RESPONSE)
    const base = assets.find(a => a.asset === 'BASE.ETH')
    expect(base).toBeTruthy()
    expect(base!.chainId).toBe('base')
    expect(base!.chainFamily).toBe('evm')
  })

  test('filters out unknown chains', () => {
    const assets = parseAssetsResponse(FIXTURE_ASSETS_RESPONSE)
    const unknown = assets.find(a => a.asset === 'UNKNOWN.FOO')
    expect(unknown).toBeUndefined()
  })

  test('parses flat array response (single unwrap)', () => {
    const assets = parseAssetsResponse(FIXTURE_ASSETS_FLAT)
    expect(assets.length).toBe(2)
    expect(assets[0].asset).toBe('BTC.BTC')
    expect(assets[1].asset).toBe('ETH.ETH')
  })

  test('throws on empty response', () => {
    expect(() => parseAssetsResponse(null))
      .toThrow('Pioneer GetAvailableAssets returned empty response')
  })

  test('throws on non-array response', () => {
    expect(() => parseAssetsResponse({ data: { data: 'not-an-array' } }))
      .toThrow('unexpected response shape')
  })
})
