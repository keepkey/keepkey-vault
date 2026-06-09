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

/** Assets response from Pioneer GetAvailableAssets — every entry includes
 *  caip per pioneer-server's swap-config controller contract (the response is
 *  built from a CAIP-keyed whitelist). The token-without-caip fixture below
 *  pins the malformed-response defense. */
const FIXTURE_ASSETS_RESPONSE = {
  data: {
    success: true,
    data: {
      assets: [
        { asset: 'BTC.BTC', symbol: 'BTC', name: 'Bitcoin', decimals: 8,
          caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0' },
        { asset: 'ETH.ETH', symbol: 'ETH', name: 'Ethereum', decimals: 18,
          caip: 'eip155:1/slip44:60' },
        { asset: 'ETH.USDT-0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether USD', decimals: 6,
          caip: 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7' },
        { asset: 'GAIA.ATOM', symbol: 'ATOM', name: 'Cosmos Hub', decimals: 6,
          caip: 'cosmos:cosmoshub-4/slip44:118' },
        { asset: 'BASE.ETH', symbol: 'ETH', name: 'Base ETH', decimals: 18,
          caip: 'eip155:8453/slip44:60' },
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
  // CAIP-only — Pioneer's Quote endpoint is the source of truth for routing.
  const baseParams = { fromCaip: 'eip155:8453/slip44:60', toCaip: 'eip155:1/slip44:60', slippageBps: 300 }

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

  // BTC → ETH (no router, memo in txParams)
  test('BTC → ETH: extracts memo from txParams', () => {
    const params = { fromCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0', toCaip: 'eip155:1/slip44:60', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_BTC_TO_ETH_QUOTE, params)
    expect(result.memo).toBe('=:ETH.ETH:0xdest456:125000')
  })

  test('BTC → ETH: inboundAddress from txParams.vaultAddress', () => {
    const params = { fromCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0', toCaip: 'eip155:1/slip44:60', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_BTC_TO_ETH_QUOTE, params)
    expect(result.inboundAddress).toBe('bc1qvaultaddress')
  })

  test('BTC → ETH: router is undefined (UTXO chains have no router)', () => {
    const params = { fromCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0', toCaip: 'eip155:1/slip44:60', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_BTC_TO_ETH_QUOTE, params)
    expect(result.router).toBeUndefined()
  })

  test('BTC → ETH: estimatedTime from raw.total_swap_seconds', () => {
    const params = { fromCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0', toCaip: 'eip155:1/slip44:60', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_BTC_TO_ETH_QUOTE, params)
    expect(result.estimatedTime).toBe(900)
  })

  test('BTC → ETH: minimumOutput calculated from slippage when no amountOutMin', () => {
    const params = { fromCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0', toCaip: 'eip155:1/slip44:60', slippageBps: 300 }
    const result = parseQuoteResponse(FIXTURE_BTC_TO_ETH_QUOTE, params)
    // 1.25 * (1 - 85/10000) = 1.25 * 0.9915 = 1.239375
    expect(parseFloat(result.minimumOutput)).toBeCloseTo(1.239375, 4)
  })

  // Minimal response (fields at top-level quote, no raw/txs)
  test('minimal: extracts fields from top-level quote properties', () => {
    const params = { fromCaip: 'eip155:1/slip44:60', toCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0', slippageBps: 300 }
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
    const params = { fromCaip: 'eip155:1/slip44:60', toCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0', slippageBps: 300 }
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
      .toThrow(/No quote output for/)
  })

  test('throws on zero output amount (Pioneer schema drift / no liquidity)', () => {
    const badResp = { data: [{ quote: { buyAmount: '0', inbound_address: '0x123' } }] }
    expect(() => parseQuoteResponse(badResp, baseParams))
      .toThrow(/No quote output for/)
  })

  test('accepts new Pioneer field names (expectedAmountOut, amount_out)', () => {
    const camel = { data: [{ quote: { expectedAmountOut: '2.5', inbound_address: '0xv', memo: '=:ETH.ETH:0xdest' } }] }
    expect(parseQuoteResponse(camel, baseParams).expectedOutput).toBe('2.5')
    const snake = { data: [{ quote: { amount_out: '3.7', inbound_address: '0xv', memo: '=:ETH.ETH:0xdest' } }] }
    expect(parseQuoteResponse(snake, baseParams).expectedOutput).toBe('3.7')
  })

  test('throws on missing inbound address', () => {
    const badResp = { data: [{ quote: { buyAmount: '1.0' } }] }
    expect(() => parseQuoteResponse(badResp, baseParams))
      .toThrow('Quote response missing inbound address')
  })

  test('native THORChain RUNE deposit: missing inbound is OK (uses MsgDeposit)', () => {
    // The check that previously string-compared `params.fromAsset === 'THOR.RUNE'`
    // is now CAIP-driven. Pin the canonical CAIP so anyone who renames or moves
    // the constant in swap-parsing.ts has to also update this test.
    const RUNE_CAIP = 'cosmos:thorchain-mainnet-v1/slip44:931'
    const resp = { data: [{ quote: { buyAmount: '1.0' } }] }
    const params = { fromCaip: RUNE_CAIP, toCaip: 'eip155:1/slip44:60', slippageBps: 300 }
    expect(() => parseQuoteResponse(resp, params)).not.toThrow()
  })

  test('native Mayachain CACAO deposit: missing inbound is OK (uses MsgDeposit)', () => {
    const CACAO_CAIP = 'cosmos:mayachain-mainnet-v1/slip44:931'
    const resp = { data: [{ quote: { buyAmount: '1.0' } }] }
    const params = { fromCaip: CACAO_CAIP, toCaip: 'eip155:1/slip44:60', slippageBps: 300 }
    expect(() => parseQuoteResponse(resp, params)).not.toThrow()
  })

  test('error message uses CAIPs (not THORChain asset strings)', () => {
    // The "Unsupported THORChain chain" class of errors is gone — vault is
    // CAIP-native — so error messages must reference CAIPs.
    const params = {
      fromCaip: 'eip155:1/slip44:60',
      toCaip: 'eip155:10/erc20:0x9560e827af36c94d2ac33a39bce1fe78631088db', // VELO
      slippageBps: 300,
    }
    const noOutput = { data: [{ quote: { inbound_address: '0xv' } }] }
    expect(() => parseQuoteResponse(noOutput, params))
      .toThrow(/eip155:10\/erc20:0x9560/)
  })

  // ── Deposit-channel protocols (Chainflip, NEAR Intents EVM side) ───

  test('Chainflip ETH→BTC: data="0x" creates deposit-channel relayTx (not rejected)', () => {
    // The real Pioneer response for ETH→BTC when THORChain is offline: Chainflip
    // via ShapeShift. Chainflip uses a deposit-channel model — the BTC destination
    // was registered when the quote was created; the user just sends a plain ETH
    // transfer to the deposit contract address. `data = '0x'` is intentional.
    const btcCaip = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
    const ethCaip = 'eip155:1/slip44:60'
    const resp = {
      data: [{
        integration: 'shapeshiftSwap',
        quote: {
          swapper: 'Chainflip',
          buyAmount: '0.0002685',
          txs: [{ txParams: {
            to: '0xd054199c7c2d30a38cebae7a9c1ca238f932be80',
            data: '0x',
            value: '10000000000000000',
          } }],
        },
      }],
    }
    const result = parseQuoteResponse(resp, { fromCaip: ethCaip, toCaip: btcCaip, slippageBps: 300 })
    expect(result.relayTx).toBeDefined()
    expect(result.relayTx!.data).toBe('0x')
    expect(result.relayTx!.isDepositChannel).toBe(true)
    expect(result.swapper).toBe('Chainflip')
  })

  test('NEAR Intents ETH→BTC: EVM source treated as deposit channel', () => {
    const btcCaip = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
    const ethCaip = 'eip155:1/slip44:60'
    const resp = {
      data: [{
        integration: 'shapeshift',
        quote: {
          swapper: 'NEAR Intents',
          buyAmount: '0.002',
          txs: [{ txParams: { data: '0x', to: '0xnear_deposit', value: '10000000000000000' } }],
        },
      }],
    }
    const result = parseQuoteResponse(resp, { fromCaip: ethCaip, toCaip: btcCaip, slippageBps: 300 })
    expect(result.swapper).toBe('NEAR Intents')
    expect(result.relayTx?.to).toBe('0xnear_deposit')
    expect(result.relayTx?.isDepositChannel).toBe(true)
  })

  test('Relay with data="0x" is NOT a deposit channel — no relayTx created', () => {
    // Relay is a pure calldata protocol; empty calldata = malformed quote.
    // Without isDepositChannel, the guard in buildRelaySwapTx will catch it.
    const ethCaip = 'eip155:1/slip44:60'
    const usdcCaip = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    const resp = {
      data: [{
        integration: 'shapeshift',
        quote: {
          swapper: 'Relay',
          buyAmount: '100.0',
          memo: 'MEMO',
          inbound_address: '0xvault',
          txs: [{ txParams: { data: '0x', to: '0xdest', value: '1000' } }],
        },
      }],
    }
    // data='0x' with swapper=Relay → not a deposit channel, relayTx not created
    const result = parseQuoteResponse(resp, { fromCaip: ethCaip, toCaip: usdcCaip, slippageBps: 100 })
    expect(result.relayTx).toBeUndefined()
    // Memo path used instead
    expect(result.memo).toBe('MEMO')
  })

  test('NEAR Intents BTC→ETH (UTXO source, no memo) — memoless transfer succeeds', () => {
    const btcCaip = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
    const ethCaip = 'eip155:1/slip44:60'
    const resp = {
      data: [{
        integration: 'shapeshift',
        quote: {
          swapper: 'NEAR Intents',
          buyAmount: '0.05',
          inbound_address: 'bc1qnearintentsdeposit',
          txs: [{ txParams: { to: 'bc1qnearintentsdeposit', senderAddress: 'bc1qmysender' } }],
        },
      }],
    }
    const result = parseQuoteResponse(resp, { fromCaip: btcCaip, toCaip: ethCaip, slippageBps: 300 })
    expect(result.swapper).toBe('NEAR Intents')
    expect(result.inboundAddress).toBe('bc1qnearintentsdeposit')
    expect(result.memo).toBe('')
    expect(result.relayTx).toBeUndefined()
    expect(result.nearIntentsRefundTo).toBe('bc1qmysender')
  })

  test('NEAR Intents ZEC→ETH (UTXO source) — extracts nearIntentsRefundTo from senderAddress', () => {
    const zecCaip = 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
    const ethCaip = 'eip155:1/slip44:60'
    const userZecAddr = 't1Rv7QGamKCVGQgUvJNLYYaxPMq5t4cBgua'
    const resp = {
      data: [{
        integration: 'shapeshift',
        quote: {
          swapper: 'NEAR Intents',
          buyAmount: '0.05',
          inbound_address: 'zec_deposit_addr',
          txs: [{ txParams: { to: 'zec_deposit_addr', senderAddress: userZecAddr } }],
        },
      }],
    }
    const result = parseQuoteResponse(resp, { fromCaip: zecCaip, toCaip: ethCaip, slippageBps: 300 })
    expect(result.swapper).toBe('NEAR Intents')
    expect(result.nearIntentsRefundTo).toBe(userZecAddr)
  })

  test('NEAR Intents first in list — selected as best (Pioneer ranks it first)', () => {
    const btcCaip = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
    const ethCaip = 'eip155:1/slip44:60'
    const resp = {
      data: [
        {
          integration: 'shapeshift',
          quote: { swapper: 'NEAR Intents', buyAmount: '0.0001', txs: [{ txParams: { data: '0x', to: '0xnear' } }] },
        },
        {
          integration: 'shapeshiftSwap',
          quote: {
            swapper: 'Chainflip',
            buyAmount: '0.0002685',
            txs: [{ txParams: { to: '0xchainflip_deposit', data: '0x', value: '10000000000000000' } }],
          },
        },
      ],
    }
    const result = parseQuoteResponse(resp, { fromCaip: ethCaip, toCaip: btcCaip, slippageBps: 300 })
    expect(result.swapper).toBe('NEAR Intents')
    expect(result.relayTx?.isDepositChannel).toBe(true)
  })

  // ── Buildable-quote selection (scan past unbuildable head quotes) ──

  test('unbuildable NEAR Intents head quote — falls through to buildable quotes[1]', () => {
    // NEAR memoless with no deposit address and no calldata on a non-UTXO
    // source is unbuildable. Previously quotes[0] was taken unconditionally,
    // so this killed the pair even with a buildable Chainflip route behind it.
    const btcCaip = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
    const ethCaip = 'eip155:1/slip44:60'
    const resp = {
      data: [
        {
          integration: 'shapeshift',
          // inbound_address present but no memo, no txParams.to (no deposit
          // channel), no calldata, non-UTXO source → "No supported routes"
          quote: { swapper: 'NEAR Intents', buyAmount: '0.0003', inbound_address: 'near_deposit_addr', txs: [{ txParams: {} }] },
        },
        {
          integration: 'shapeshiftSwap',
          quote: {
            swapper: 'Chainflip',
            buyAmount: '0.0002685',
            txs: [{ txParams: { to: '0xchainflip_deposit', data: '0x', value: '10000000000000000' } }],
          },
        },
      ],
    }
    const result = parseQuoteResponse(resp, { fromCaip: ethCaip, toCaip: btcCaip, slippageBps: 300 })
    expect(result.swapper).toBe('Chainflip')
    expect(result.relayTx?.isDepositChannel).toBe(true)
  })

  test('NEAR Intents is the ONLY quote and unbuildable — still throws No supported routes', () => {
    const btcCaip = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
    const ethCaip = 'eip155:1/slip44:60'
    const resp = {
      data: [{
        integration: 'shapeshift',
        quote: { swapper: 'NEAR Intents', buyAmount: '0.0003', inbound_address: 'near_deposit_addr', txs: [{ txParams: {} }] },
      }],
    }
    expect(() => parseQuoteResponse(resp, { fromCaip: ethCaip, toCaip: btcCaip, slippageBps: 300 }))
      .toThrow(/No supported routes for this pair.*NEAR Intents/)
  })

  test('zero-output head quote — falls through to buildable quotes[1]', () => {
    const ethCaip = 'eip155:1/slip44:60'
    const usdcCaip = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    const resp = {
      data: [
        { integration: 'thorchain', quote: { buyAmount: '0', memo: 'MEMO', inbound_address: '0xvault' } },
        {
          integration: 'shapeshift',
          quote: {
            swapper: 'Relay',
            buyAmount: '100.0',
            txs: [{ txParams: { data: '0x12345678000000000000000000000000000000000000000000', to: '0xrelayRouter', value: '0', chainId: 1 } }],
          },
        },
      ],
    }
    const result = parseQuoteResponse(resp, { fromCaip: ethCaip, toCaip: usdcCaip, slippageBps: 300 })
    expect(result.swapper).toBe('Relay')
    expect(result.expectedOutput).toBe('100.0')
  })

  test('relayTx with real calldata to EVM destination is still accepted', () => {
    // Relay ETH → USDC (same chain, EVM destination) should work fine.
    const ethCaip = 'eip155:1/slip44:60'
    const usdcCaip = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    const resp = {
      data: [{
        integration: 'shapeshift',
        quote: {
          swapper: 'Relay',
          buyAmount: '100.0',
          txs: [{ txParams: {
            data: '0x12345678000000000000000000000000000000000000000000',
            to: '0xrelayRouter', value: '1000000000000000',
            chainId: 1, gasLimit: '300000',
          } }],
        },
      }],
    }
    const result = parseQuoteResponse(resp, { fromCaip: ethCaip, toCaip: usdcCaip, slippageBps: 300 })
    expect(result.relayTx).toBeDefined()
    expect(result.relayTx!.isDepositChannel).toBeUndefined()
    expect(result.relayTx!.data).toBe('0x12345678000000000000000000000000000000000000000000')
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

  test('preserves token caip from pioneer-server (case-sensitive)', () => {
    // pioneer-server's swap-config controller emits caip with lowercase
    // contract for EVM tokens (CAIP-19 spec) — vault must NOT silently
    // fall back to the native chain CAIP when raw.caip is present.
    const assets = parseAssetsResponse(FIXTURE_ASSETS_RESPONSE)
    const usdt = assets.find(a => a.symbol === 'USDT' && a.contractAddress)
    expect(usdt).toBeTruthy()
    expect(usdt!.caip).toBe('eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7')
    expect(usdt!.caip).not.toBe('eip155:1/slip44:60') // would be the bug — token attached to native CAIP
  })

  test('drops malformed token assets (missing caip) instead of falling back to native', () => {
    // If pioneer-server ever emits a token entry without caip, the previous
    // `raw.caip || chainDef.caip` fallback would make the token quote against
    // the chain's NATIVE CAIP — silent corruption. Defense: drop + warn.
    const malformed = {
      data: {
        success: true,
        data: {
          assets: [
            { asset: 'ETH.ETH', symbol: 'ETH', decimals: 18,
              caip: 'eip155:1/slip44:60' }, // native — fine
            { asset: 'ETH.USDT-0xdAC17F958D2ee523a2206206994597C13D831ec7',
              symbol: 'USDT', decimals: 6 }, // token without caip — should be dropped
          ],
        },
      },
    }
    const assets = parseAssetsResponse(malformed)
    expect(assets.length).toBe(1)
    expect(assets[0].asset).toBe('ETH.ETH')
    // The token was dropped, not silently keyed under native CAIP.
    expect(assets.find(a => a.symbol === 'USDT')).toBeUndefined()
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
