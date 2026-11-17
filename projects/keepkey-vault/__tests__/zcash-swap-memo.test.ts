import { expect, test } from 'bun:test'
import { assertSwapMemoFitsSource, parseQuoteResponse } from '../src/bun/swap-parsing'
import { buildUtxoTx } from '../src/bun/txbuilder/utxo'
import { CHAINS } from '../src/shared/chains'

const ZEC = 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
const BTC = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
const ETH = 'eip155:1/slip44:60'
const MEMO = '=:ETH.ETH:0x1111111111111111111111111111111111111111:1000'
const UNSUPPORTED = 'requires an on-chain routing memo'
const params = { fromCaip: ZEC, toCaip: ETH, slippageBps: 300 }
function memoRoute() {
  return { integration: 'thorchain', quote: { buyAmount: '0.08', inbound_address: 't1RoutingVault', memo: MEMO } }
}
function plainRoute(swapper = 'NEAR Intents') {
  return { integration: 'shapeshift', quote: { swapper, buyAmount: '0.05', inbound_address: 't1RegisteredDeposit',
    txs: [{ txParams: { to: 't1RegisteredDeposit', senderAddress: 't1Refund' } }] } }
}

for (const swapper of ['NEAR Intents', 'Chainflip']) test(`ZEC quote selection skips a higher-output memo route for the supported ${swapper} deposit`, () => {
  const response = { data: [memoRoute(), plainRoute(swapper)] }
  const original = structuredClone(response)
  const selected = parseQuoteResponse(response, params)
  expect(selected.swapper).toBe(swapper)
  expect(selected.expectedOutput).toBe('0.05')
  expect(selected.memo).toBe('')
  expect(selected.inboundAddress).toBe('t1RegisteredDeposit')
  expect(response).toEqual(original)
})

for (const location of ['quote', 'txParams', 'raw'] as const) test(`ZEC-only memo route in ${location} fails at quote selection without telling the user to clear instructions`, () => {
  const route: any = memoRoute()
  delete route.quote.memo
  if (location === 'quote') route.quote.memo = MEMO
  if (location === 'txParams') route.quote.txs = [{ txParams: { memo: MEMO } }]
  if (location === 'raw') route.quote.raw = { memo: MEMO }
  const error = (() => { try { parseQuoteResponse({ data: [route] }, params) } catch (error) { return error as Error } })()
  expect(error?.message).toContain(UNSUPPORTED)
  expect(error?.message).toContain('memo-free route')
  expect(error?.message).not.toMatch(/clear.*memo/i)
  expect(route.quote.memo ?? route.quote.txs?.[0].txParams.memo ?? route.quote.raw?.memo).toBe(MEMO)
})

test('the shared preview/execution memo preflight rejects ZEC routing instructions without affecting BTC or incoming ZEC', () => {
  expect(() => assertSwapMemoFitsSource(MEMO, ZEC)).toThrow(UNSUPPORTED)
  expect(() => assertSwapMemoFitsSource('', ZEC)).not.toThrow()
  expect(() => assertSwapMemoFitsSource(MEMO, BTC)).not.toThrow()
  const result = parseQuoteResponse({ data: [memoRoute()] }, { ...params, fromCaip: BTC, toCaip: ZEC })
  expect(result.memo).toBe(MEMO)
})

test('stale ZEC swap previews reject before UTXO access and keep the optional-note error for ordinary sends', async () => {
  let reads = 0
  const pioneer = { ListUnspent: () => { reads++; throw Error('should not fetch') } }
  const chain = CHAINS.find(chain => chain.id === 'zcash')!
  const request = { to: 't1RoutingVault', amount: '1', memo: MEMO, xpub: 'unused' }
  await expect(buildUtxoTx(pioneer, chain, { ...request, isSwapDeposit: true })).rejects.toThrow(UNSUPPORTED)
  await expect(buildUtxoTx(pioneer, chain, request)).rejects.toThrow('Clear the memo and rebuild')
  expect(reads).toBe(0)
})
