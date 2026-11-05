import { afterEach, expect, mock, test } from 'bun:test'
import { CHAINS } from '../src/shared/chains'
import { parseQuoteResponse } from '../src/bun/swap-parsing'
import type { ExecuteSwapParams } from '../src/shared/types'
import { fakeTronGrid } from './fixtures/fake-trongrid'
import { decodeTronTransfer } from '../src/bun/tron-preview'
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

// Isolated suite: exercise real preview/execution and native transfer builders,
// while stopping at the signing boundary. No device or network is contacted.
const builds: Array<{ kind: string; params: any }> = []
const pioneer = {
  GetAvailableAssets: async () => ({ data: [] }),
  BuildSolanaTransfer: async (params: any) => { builds.push({ kind: 'sol', params }); return { data: { serialized: 'fixture-native-sol' } } },
  BuildSolanaTransferToken: async (params: any) => { builds.push({ kind: 'spl', params }); return { data: { serialized: 'fixture-spl' } } },
  GetAccountInfo: async (params: any) => { builds.push({ kind: 'xrp', params }); return { data: { Sequence: 42, ledger_index_current: 100, Balance: '100000000' } } },
}
mock.module('../src/bun/pioneer', () => ({ getPioneer: async () => pioneer, getPioneerApiBase: () => 'https://fixture.invalid', getQueryKey: () => 'fixture' }))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: '/private/tmp/vault-near-build-test' } } }))
const { previewSwapBuild, executeSwap } = await import('../src/bun/swap')

test('an expired EVM router deadline is refused instead of silently extended', async () => {
  let signs = 0
  const ctx: any = { wallet: {}, getAllChains: () => CHAINS, getEvmRpcSource: () => { throw new Error('No network request expected') },
    pushSubStage: () => {}, wrapSign: async () => { signs++; throw new Error('No device request expected') } }
  const params: ExecuteSwapParams = { fromChainId: 'ethereum', toChainId: 'ripple', fromCaip: 'eip155:1/slip44:60',
    toCaip: CHAINS.find(c => c.id === 'ripple')!.caip, amount: '0.003', memo: '=:XRP.XRP:rRecipient',
    inboundAddress: '0xVault', router: '0xRouter', expectedOutput: '6', expiry: Math.floor(Date.now() / 1000) - 1,
    fromAddressOverride: '0xSender', toAddressOverride: 'rRecipient' }
  await expect(executeSwap(params, ctx)).rejects.toThrow(/expired/)
  expect(signs).toBe(0)
})

const sources = [
  { chain: 'solana', caip: CHAINS.find(chain => chain.id === 'solana')!.caip, amount: '0.25', kind: 'sol', base: '250000000', deposit: 'ALUVVWPJb2XY1AXzh3mxAnGVGxgwbLvYZKufs5hk1kzK' },
  { chain: 'solana', caip: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', amount: '12.345678', decimals: 6, kind: 'spl', base: '12345678', deposit: 'ALUVVWPJb2XY1AXzh3mxAnGVGxgwbLvYZKufs5hk1kzK' },
  { chain: 'ripple', caip: CHAINS.find(chain => chain.id === 'ripple')!.caip, amount: '10.123456', kind: 'xrp', base: '10123456', deposit: 'rDepositFixture' },
  { chain: 'tron', caip: CHAINS.find(chain => chain.id === 'tron')!.caip, amount: '10.123456', kind: 'trx', base: '10123456', deposit: 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax', sender: 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax' },
  { chain: 'tron', caip: 'tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amount: '12.345678', decimals: 6, kind: 'trc20', base: '12345678', deposit: 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax', sender: 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax' },
]

for (const source of sources) test(`NEAR ${source.kind} plain deposit reaches its own transfer builder in preview and execution`, async () => {
  const quote = parseQuoteResponse({ data: [{ integration: 'nearIntents', quote: {
    swapper: 'NEAR Intents', buyAmount: '0.01', amountOutMin: '0.0099', meta: { depositAddress: source.deposit },
    txs: [{ txParams: { to: source.deposit, recipientAddress: source.deposit, senderAddress: 'source-wallet', amount: source.amount } }],
  } }] }, { fromCaip: source.caip, toCaip: 'eip155:1/slip44:60' })
  expect(quote.relayTx).toBeUndefined()
  const params: ExecuteSwapParams = { fromCaip: source.caip, toCaip: 'eip155:1/slip44:60', fromChainId: source.chain, toChainId: 'ethereum',
    amount: source.amount, expectedOutput: quote.expectedOutput, inboundAddress: quote.inboundAddress, memo: quote.memo,
    integration: quote.integration, swapper: quote.swapper, relayTx: quote.relayTx, tokenDecimals: source.decimals,
    fromAddressOverride: source.sender || 'source-wallet', toAddressOverride: '0xrecipient',
  }
  let signingBoundary = false
  const ctx: any = { wallet: {}, getAllChains: () => CHAINS, getEvmRpcSource: () => { throw new Error('EVM builder must never run') },
    getBtcXpub: () => undefined, getAllBtcXpubs: () => [], getFirmwareVersion: () => '7.16.0', isAdvancedModeEnabled: () => false,
    pushSubStage: () => {}, wrapSign: async () => { signingBoundary = true; throw new Error('TEST_STOP_BEFORE_DEVICE') },
  }
  builds.length = 0
  const grid = fakeTronGrid()
  let statusReads = 0
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.origin === 'https://1click.chaindefuser.com' && url.pathname === '/v0/status') {
      expect(url.searchParams.get('depositAddress')).toBe(source.deposit)
      statusReads++
      return Response.json({ status: 'PENDING_DEPOSIT', quoteResponse: {
        quoteRequest: { refundTo: params.fromAddressOverride, refundType: 'ORIGIN_CHAIN',
          recipient: params.toAddressOverride, recipientType: 'DESTINATION_CHAIN', depositType: 'ORIGIN_CHAIN',
          deadline: new Date(Date.now() + 3_600_000).toISOString() },
        quote: { depositAddress: source.deposit },
      } })
    }
    if (source.chain === 'tron') return grid.handler(input, init)
    throw new Error(`unexpected fixture fetch: ${url.pathname}`)
  }) as typeof fetch
  const preview = await previewSwapBuild(params, ctx)
  if (source.kind === 'xrp') {
    expect(preview.unsignedTx.payment).toMatchObject({ amount: source.base, destination: source.deposit })
    expect(preview.unsignedTx.sequence).toBe('42')
  } else if (source.chain === 'tron') {
    const transfer = decodeTronTransfer(preview.unsignedTx.rawTx)
    expect(transfer.kind).toBe(source.kind === 'trc20' ? 'TRC-20 transfer' : 'TRX transfer')
    expect(transfer.units).toBe(BigInt(source.base))
    expect(transfer.to).toBe(source.deposit)
  } else {
    expect(builds[0]).toMatchObject({ kind: source.kind, params: { to: source.deposit, amount: source.base } })
    expect(preview.unsignedTx.rawTx).toContain('fixture-')
  }
  await expect(executeSwap(params, ctx)).rejects.toThrow('TEST_STOP_BEFORE_DEVICE')
  expect(statusReads).toBe(1)
  expect(signingBoundary).toBe(true)
  if (source.chain === 'tron') expect(grid.requests[source.kind === 'trc20' ? 'triggersmartcontract' : 'createtransaction']).toHaveLength(2)
  else expect(builds).toHaveLength(2)
})

test('unsupported non-EVM prebuilt transactions stop before the EVM builder or device', async () => {
  const params: ExecuteSwapParams = { fromCaip: CHAINS.find(chain => chain.id === 'ripple')!.caip, toCaip: 'eip155:1/slip44:60',
    fromChainId: 'ripple', toChainId: 'ethereum', amount: '10', expectedOutput: '0.01', inboundAddress: '', memo: '',
    fromAddressOverride: 'source-wallet', toAddressOverride: '0xrecipient', relayTx: { to: 'rDeposit', data: '0x12345678', value: '0', chainId: 0 },
  }
  const ctx: any = { wallet: {}, getAllChains: () => CHAINS, getEvmRpcSource: () => { throw new Error('EVM builder must never run') }, pushSubStage: () => {}, wrapSign: async () => { throw new Error('Device must never run') } }
  await expect(previewSwapBuild(params, ctx)).rejects.toThrow('Unsupported prebuilt swap transaction for Ripple')
  await expect(executeSwap(params, ctx)).rejects.toThrow('Unsupported prebuilt swap transaction for Ripple')
})
