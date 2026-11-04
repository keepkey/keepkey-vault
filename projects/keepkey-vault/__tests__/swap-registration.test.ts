import { expect, test } from 'bun:test'
import { buildPioneerSwapRegistration } from '../src/shared/swap-registration'
import type { PendingSwap } from '../src/shared/types'

const near: PendingSwap = {
  txid: '0xinput', fromCaip: 'eip155:1/slip44:60', toCaip: 'eip155:42161/slip44:60',
  fromAsset: 'ETH.ETH', toAsset: 'ARB.ETH', fromSymbol: 'ETH', toSymbol: 'ETH',
  fromChainId: 'ethereum', toChainId: 'arbitrum', fromAmount: '0.01', expectedOutput: '0.009123456789123456',
  minimumOutput: '0.009000000000000001', memo: '', inboundAddress: '0xdeposit', integration: 'nearIntents',
  swapper: 'NEAR Intents', status: 'pending', confirmations: 0, createdAt: 1, updatedAt: 1, estimatedTime: 60,
  trackingContext: { fromAddress: '0xsender', toAddress: '0xcustom', nearIntents: {
    depositAddress: '0xdeposit', refundTo: '0xquote-refund', recipient: '0xcustom',
    originAsset: 'nep141:eth', destinationAsset: 'nep141:arb', sourceDecimals: 18, destinationDecimals: 18,
    minimumAmountOut: '0.009000000000000001',
  } },
}

test('NEAR registration separates the actual sender from deposit and keeps exact minimum and units', () => {
  const body = buildPioneerSwapRegistration(near)
  expect(body.integration).toBe('shapeshift')
  expect(body.swapper).toBe('NEAR Intents')
  expect(body.sellAsset.address).toBe('0xsender')
  expect(body.sellAsset.amountBaseUnits).toBe('10000000000000000')
  expect(body.buyAsset.address).toBe('0xcustom')
  expect(body.buyAsset.amountBaseUnits).toBe('9123456789123456')
  expect(body.quote.minimumAmountOut).toBe('0.009000000000000001')
  expect(body.nearIntentsData).toEqual({ ...near.trackingContext!.nearIntents, refundTo: '0xsender' })
})

test('legacy NEAR registrations cannot turn the deposit address into a refund wallet', () => {
  const body = buildPioneerSwapRegistration({ ...near, trackingContext: undefined })
  expect(body.sellAsset.address).toBe('')
  expect(body.nearIntentsData.depositAddress).toBe('0xdeposit')
  expect(body.nearIntentsData.refundTo).toBeUndefined()
  expect(body.sellAsset.amountBaseUnits).toBeUndefined()
})

test('retries retain Relay solver mode and correct CAIP network rather than vault chain names', () => {
  const body = buildPioneerSwapRegistration({ ...near, integration: 'relay', swapper: 'Relay', relayRequestId: '0xrequest',
    trackingContext: { fromAddress: '0xsender', toAddress: '0xcustom', fromAmountBaseUnits: '10000000000000000', relaySolverDeposit: true },
  })
  expect(body.sellAsset.networkId).toBe('eip155:1')
  expect(body.buyAsset.networkId).toBe('eip155:42161')
  expect(body.relayData).toEqual({ requestId: '0xrequest', executionMode: 'solver-deposit' })
  expect(body.nearIntentsData).toBeUndefined()
})
