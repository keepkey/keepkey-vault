import { describe, expect, test } from 'bun:test'
import { parseSwapFeeDisclosure } from '../src/bun/swap-fees'
const eth = 'eip155:1/slip44:60'
const usdt = 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7'
const ltc = 'bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2'
const context = { fromCaip: eth, toCaip: usdt, integration: 'relay', swapper: 'Relay' }

describe('quote fee currencies and units', () => {
  test('Relay source ETH app fees remain ETH when destination is USDT', () => {
    const currency = { chainId: 1, address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 }
    const result = parseSwapFeeDisclosure({ fees: {
      total_bps: 30, affiliate: '39354585000000',
      app: { amount: '39354585000000', currency }, gas: { amount: '3474126782757', currency },
      relayer: { amount: '23586338546513', currency }, relayerGas: { amount: '413082225272', currency }, relayerService: { amount: '23173256321241', currency },
    } }, {}, context)
    expect(result.reportedTotalBps).toBe(30)
    expect(result.items).toHaveLength(3)
    expect(result.items[0]).toMatchObject({ kind: 'affiliate', assetCaip: eth, symbol: 'ETH', amountBaseUnits: '39354585000000', amount: '0.000039354585' })
    expect(result.items.every(item => item.symbol === 'ETH')).toBe(true)
    expect(result.items[2].amount).toBe('0.000023586338546513')
  })
  test('typed gateway fee amounts are converted only with their own decimals', () => {
    const result = parseSwapFeeDisclosure({ fees: { total_bps: 35, items: [
      { kind: 'affiliate', assetCaip: eth, symbol: 'ETH', decimals: 18, amountBaseUnits: '31978500000000', bps: 15, recipient: 'keepkey-account' },
      { kind: 'network', assetCaip: ltc, symbol: 'LTC', decimals: 8, amountBaseUnits: '500' },
    ] } }, {}, { ...context, toCaip: ltc, integration: 'nearIntents' })
    expect(result.items[0]).toMatchObject({ symbol: 'ETH', amount: '0.0000319785', recipient: 'keepkey-account', bps: 15 })
    expect(result.items[1]).toMatchObject({ symbol: 'LTC', amount: '0.000005' })
  })
  test('NEAR legacy app fees use input units, while withdrawal cost uses output units', () => {
    const result = parseSwapFeeDisclosure({ quoteRequest: { amount: '21319000000000000', appFees: [{ recipient: 'keepkey', fee: 15 }, { recipient: 'platform', fee: 20 }] },
      quote: { amountIn: '21319000000000000', withdrawFee: '500' } }, {}, { ...context, toCaip: ltc, integration: 'nearIntents', swapper: 'NEAR Intents' })
    expect(result.reportedTotalBps).toBe(35)
    expect(result.items.map(item => [item.symbol, item.amount])).toEqual([['ETH', '0.0000319785'], ['ETH', '0.000042638'], ['LTC', '0.000005']])
  })
  test('THORChain USDT fees are protocol 1e8 units, not native USDT 1e6 units', () => {
    const result = parseSwapFeeDisclosure({ fees: { affiliate: '7329702', outbound: '24992500', total_bps: 150 } }, {}, { ...context, integration: 'thorchain', swapper: 'THORChain' })
    expect(result.items.map(item => [item.symbol, item.amount])).toEqual([['USDT', '0.07329702'], ['USDT', '0.249925']])
  })
  test('direct Uniswap human output fee is not divided again', () => {
    const result = parseSwapFeeDisclosure({ fees: { affiliate: '1', outbound: '0', total_bps: 30 } }, {}, { ...context, integration: 'uniswap', swapper: 'Uniswap' })
    expect(result.items[0]).toMatchObject({ assetCaip: usdt, symbol: 'USDT', amount: '1' })
  })
  test('0x amounts use the explicitly reported fee token', () => {
    const result = parseSwapFeeDisclosure({ fees: { integratorFee: { token: usdt.split('erc20:')[1], amount: '90105' }, zeroExFee: { token: usdt.split('erc20:')[1], amount: '45052' } } }, {}, { ...context, integration: 'zeroex', swapper: '0x' })
    expect(result.items.map(item => [item.kind, item.symbol, item.amount])).toEqual([['affiliate', 'USDT', '0.090105'], ['provider', 'USDT', '0.045052']])
    expect(result.reportedTotalBps).toBeUndefined()
  })
  test('ShapeShift rates do not manufacture a destination currency amount', () => {
    const result = parseSwapFeeDisclosure({ fees: { affiliate: '0', outbound: '0', total_bps: 40 } }, { meta: { feeBreakdown: { partner: { bps: 30 }, shapeshift: { bps: 10 } } } }, { ...context, integration: 'shapeshift', swapper: 'NEAR Intents' })
    expect(result.items.map(item => [item.label, item.bps, item.amount, item.symbol])).toEqual([['Partner fee', 30, undefined, undefined], ['ShapeShift fee', 10, undefined, undefined]])
  })
  test('untyped unknown integers and malformed typed metadata never become buy-token costs', () => {
    const result = parseSwapFeeDisclosure({ fees: { affiliate: '39354585000000', outbound: '12345678' } }, {}, { ...context, integration: 'unknown', swapper: undefined })
    expect(result.items).toEqual([])
    expect(result.reportedTotalBps).toBeUndefined()
    const malformed = parseSwapFeeDisclosure({ fees: { items: [{ kind: 'affiliate', assetCaip: eth, symbol: 'ETH', decimals: -1, amountBaseUnits: '1234', bps: 30 }] } }, {}, context)
    expect(malformed.items).toEqual([{ kind: 'affiliate', bps: 30 }])
  })
})
