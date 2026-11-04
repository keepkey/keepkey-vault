import { afterEach, expect, mock, test } from 'bun:test'
const fetchBefore = globalThis.fetch
afterEach(() => { globalThis.fetch = fetchBefore })
const records = new Map<string, any>()
mock.module('../src/bun/db', () => ({
  insertSwapHistory: () => {}, getSwapHistory: () => [],
  getSwapHistoryByTxid: (txid: string) => records.get(txid),
  updateSwapHistoryStatus: (txid: string, status: string) => { records.get(txid).status = status },
  setSwapRelayRequestId: () => {},
}))
mock.module('../src/bun/ledger', () => ({ recordSwap: () => {} }))
mock.module('../src/bun/engine-controller', () => ({ withTimeout: async (operation: Promise<any>) => operation }))
mock.module('../src/bun/pioneer', () => ({ getPioneer: async () => ({
  GetPendingSwap: async () => ({ data: { status: 'pending', confirmations: 0 } }),
  CreatePendingSwap: async () => ({}),
}) }))
const { refreshSwap } = await import('../src/bun/swap-tracker')
const from = '0x1111111111111111111111111111111111111111'
const deposit = '0x2222222222222222222222222222222222222222'
const recipient = 'rRecipientFixture'
function fixture(txid: string) {
  const row = { txid, status: 'pending', fromCaip: 'eip155:1/slip44:60',
    toCaip: 'ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144',
    fromAmount: '0.003', quotedOutput: '5', minimumOutput: '4.9', fromChainId: 'ethereum', toChainId: 'ripple',
    integration: 'nearIntents', swapper: 'NEAR Intents', inboundAddress: deposit,
    createdAt: Date.now() - 60_000, updatedAt: Date.now(), trackingContext: {
      fromAddress: from, toAddress: recipient, nearIntents: { depositAddress: deposit,
        originAsset: 'nep141:eth.omft.near', destinationAsset: 'nep141:xrp.omft.near', sourceDecimals: 18, destinationDecimals: 6 },
    } }
  records.set(txid, row)
  return (state: string) => ({ status: state, quoteResponse: {
    quoteRequest: { dry: false, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE', depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN', recipientType: 'DESTINATION_CHAIN', refundTo: from, recipient,
      originAsset: 'nep141:eth.omft.near', destinationAsset: 'nep141:xrp.omft.near', amount: '3000000000000000' },
    quote: { depositAddress: deposit, amountIn: '3000000000000000', amountOut: '5000000', minAmountOut: '4900000' },
  }, swapDetails: { originChainTxHashes: [{ hash: txid }], destinationChainTxHashes: [{ hash: 'b'.repeat(64) }],
    depositedAmount: '3000000000000000', amountOut: '5000000' } })
}
test('1Click processing survives a stale Pioneer pending response in the same poll', async () => {
  const txid = '0x' + 'a'.repeat(64), status = fixture(txid)
  globalThis.fetch = (async () => Response.json(status('PROCESSING'))) as typeof fetch
  const swap = await refreshSwap(txid)
  expect(swap?.status).toBe('confirming')
  expect(records.get(txid).status).toBe('confirming')
  globalThis.fetch = (async () => Response.json(status('PENDING_DEPOSIT'))) as typeof fetch
  expect((await refreshSwap(txid))?.status).toBe('confirming')
})
test('an older overlapping poll cannot overwrite a verified completed payout', async () => {
  const txid = '0x' + 'c'.repeat(64), status = fixture(txid)
  let completeOld: ((response: Response) => void) | undefined
  globalThis.fetch = (() => new Promise<Response>(resolve => { completeOld = resolve })) as typeof fetch
  const oldPoll = refreshSwap(txid)
  globalThis.fetch = (async () => Response.json(status('SUCCESS'))) as typeof fetch
  expect((await refreshSwap(txid))?.status).toBe('completed')
  completeOld!(Response.json(status('PROCESSING')))
  expect((await oldPoll)?.status).toBe('completed')
  expect(records.get(txid).status).toBe('completed')
})
