import { afterAll, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSwapQuoteLeases } from '../src/bun/swap-quote-lease'
import { assessSwapRisk } from '../src/shared/swap-risk'
import type { SwapAsset, SwapQuote, ExecuteSwapParams } from '../src/shared/types'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-swap-approval-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
const { startRestApi } = await import('../src/bun/rest-api')
db.initDb()
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

async function exercise(change: Record<string, unknown>, options: { max?: boolean; approve?: boolean; expireWhileApproving?: boolean } = {}) {
  let time = 1_000_000, epoch = 7
  const leases = createSwapQuoteLeases(() => time)
  const request = { fromCaip: 'eip155:1/slip44:60', toCaip: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
    amount: '0.003', fromAddress: '0xSender', toAddress: 'SolRecipient', isMax: !!options.max }
  const quote: SwapQuote = { expectedOutput: '0.07', minimumOutput: '0.069', memo: '', inboundAddress: '0xDeposit',
    fees: { affiliate: '0', outbound: '0', totalBps: 0 }, estimatedTime: 60, slippageBps: 100,
    integration: 'nearIntents', swapper: 'NEAR Intents',
    relayTx: { to: '0xDeposit', value: '3000000000000000', data: '0x', chainId: 1, isDepositChannel: true },
    ...(options.max ? { netFromAmount: '0.0029' } : {}) }
  const risk = assessSwapRisk({ inputAmount: 0.003, expectedAmount: 0.07, minimumAmount: 0.069, fromPriceUsd: 2000, toPriceUsd: 90, sameAssetUnits: false })
  const issued = leases.issue(request, quote, { chainId: 'ethereum', decimals: 18 } as SwapAsset,
    { chainId: 'solana', decimals: 9 } as SwapAsset, epoch, risk)
  const body: ExecuteSwapParams = { quoteId: issued.quoteId, fromChainId: 'ethereum', toChainId: 'solana',
    fromCaip: request.fromCaip, toCaip: request.toCaip, amount: request.amount, isMax: request.isMax,
    memo: quote.memo, inboundAddress: quote.inboundAddress, expectedOutput: quote.expectedOutput,
    integration: quote.integration, swapper: quote.swapper, relayTx: quote.relayTx, ...change }
  const engine: any = Object.assign(new EventEmitter(), { isEmulator: false, isPassphraseWallet: false,
    getDeviceState: () => ({ state: 'ready', firmwareVersion: '7.17.0', deviceId: 'swap-test' }), wallet: {},
    getCachedFeaturesSnapshot: () => undefined })
  const cards: any[] = [], signatures: string[] = []
  const auth: any = { requireAuth: () => ({ name: 'test' }), extractBearerToken: () => 'test', validate: () => true }
  const server = startRestApi(engine, auth, 0, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test', getSessionEpoch: () => epoch,
    onSigningRequest: async (card: any) => { cards.push(card); if (options.expireWhileApproving) time += 60_000; return { approved: !!options.approve } },
    validateSwapExecutionHeadless: (params: ExecuteSwapParams) => { const lease = leases.claim(params, epoch); lease.finish(false); return lease.params },
    executeSwapHeadless: async (params: ExecuteSwapParams) => {
      const lease = leases.claim(params, epoch)
      lease.beforeSign(epoch); signatures.push('fake-device'); lease.finish(true)
      return { txid: 'fixture-txid' }
    },
  } as any, '127.0.0.1')
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v2/swap/execute`, { method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as any, cards, signatures }
  } finally { server.stop(true) }
}
for (const change of [{ quoteId: undefined }, { quoteId: 'forged' }, { amount: '0.004' }, { inboundAddress: 'attacker' }, { relayTx: { data: '0xdead' } }]) {
  test(`invalid execution ${JSON.stringify(change)} is refused before any approval card`, async () => {
    const result = await exercise(change)
    expect([400, 409]).toContain(result.status)
    expect(result.cards).toEqual([])
    expect(result.signatures).toEqual([])
  })
}
test('valid native deposit still needs human approval, without a false AdvancedMode warning', async () => {
  const result = await exercise({})
  expect(result.status).toBe(403)
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].needsBlindSigning).toBeUndefined()
  expect(result.signatures).toEqual([])
})
test('MAX approval shows the exact net amount that will be sent', async () => {
  const result = await exercise({}, { max: true })
  expect(result.cards[0].value).toContain('0.0029')
  expect(result.cards[0].rawRequestBody.amount).toBe('0.0029')
  expect(result.signatures).toEqual([])
})
test('human approval does not extend quote freshness', async () => {
  const result = await exercise({}, { approve: true, expireWhileApproving: true })
  expect(result.status).toBe(502)
  expect(result.body.details).toContain('expired')
  expect(result.cards).toHaveLength(1)
  expect(result.signatures).toEqual([])
})
test('a fresh approved quote reaches only the fake device callback', async () => {
  const result = await exercise({}, { approve: true })
  expect(result.status).toBe(200)
  expect(result.signatures).toEqual(['fake-device'])
})
