import { afterEach, expect, mock, test } from 'bun:test'
import { CHAINS } from '../src/shared/chains'
import { isNearIntentsPlainDepositSource, isPlainSwapDeposit } from '../src/shared/swap-deposit-routing'

// Every NEAR Intents plain-deposit source must pass the two refund-address
// layers before a quote is returned: XRP and TRON joined the plain-deposit
// routing in 1.6.9 while the check still covered only BTC and Solana.
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

let pioneerRefundTo: string | undefined
const pioneer = {
  GetAvailableAssets: async () => ({ data: [] }),
  Quote: async (params: any) => ({ data: [{ integration: 'nearIntents', quote: {
    swapper: 'NEAR Intents', buyAmount: '0.01', amountOutMin: '0.0099', meta: { depositAddress: DEPOSIT },
    txs: [{ txParams: { to: DEPOSIT, recipientAddress: DEPOSIT, senderAddress: pioneerRefundTo ?? params.senderAddress, amount: params.sellAmount } }],
  } }] }),
}
mock.module('../src/bun/pioneer', () => ({ getPioneer: async () => pioneer, getPioneerApiBase: () => 'https://fixture.invalid', getQueryKey: () => 'fixture' }))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: '/private/tmp/vault-near-refund-test' } } }))
const { getSwapQuote } = await import('../src/bun/swap')

const DEPOSIT = 'near-deposit-fixture'
const caip = (id: string) => CHAINS.find(chain => chain.id === id)!.caip
const sources = [
  { name: 'BTC', caip: caip('bitcoin'), sender: 'bc1qsenderfixture0000000000000000000000000' },
  { name: 'SOL', caip: caip('solana'), sender: 'So1SenderFixture1111111111111111111111111111' },
  { name: 'XRP', caip: caip('ripple'), sender: 'rSenderFixture1111111111111111111' },
  { name: 'TRX', caip: caip('tron'), sender: 'TSenderFixture111111111111111111111' },
  { name: 'USDT-TRON', caip: 'tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', sender: 'TSenderFixture111111111111111111111' },
]

function oneClick(status: number, body: any) {
  const calls: string[] = []
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url))
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}
const intent = (refundTo: string, depositMemo?: string | null) =>
  ({ quoteResponse: { quoteRequest: { refundTo }, quote: { depositAddress: DEPOSIT, ...(depositMemo !== undefined ? { depositMemo } : {}) } } })
const quote = (source: typeof sources[number], fromAddress = source.sender) =>
  getSwapQuote({ fromCaip: source.caip, toCaip: 'eip155:1/slip44:60', amount: '10', fromAddress, toAddress: '0x000000000000000000000000000000000000dEaD' } as any)

test('the refund check covers exactly the NEAR plain-deposit sources', () => {
  for (const source of sources) {
    expect(isNearIntentsPlainDepositSource(source.caip)).toBe(true)
    expect(isPlainSwapDeposit({ fromCaip: source.caip, inboundAddress: DEPOSIT, swapper: 'NEAR Intents' })).toBe(true)
  }
  expect(isNearIntentsPlainDepositSource('eip155:1/slip44:60')).toBe(false)
  expect(isPlainSwapDeposit({ fromCaip: 'eip155:1/slip44:60', inboundAddress: DEPOSIT, swapper: 'NEAR Intents' })).toBe(false)
})

for (const source of sources) {
  test(`NEAR ${source.name}: refund verified by Pioneer and 1Click before the quote is returned`, async () => {
    pioneerRefundTo = undefined
    const calls = oneClick(200, intent(source.sender, ''))
    const result = await quote(source)
    expect(result.swapper).toBe('NEAR Intents')
    expect(calls).toEqual([`https://1click.chaindefuser.com/v0/status?depositAddress=${DEPOSIT}`])
  })

  test(`NEAR ${source.name}: Pioneer refundTo that is not the sender is refused`, async () => {
    pioneerRefundTo = 'keepkey.near'
    oneClick(200, intent(source.sender))
    await expect(quote(source)).rejects.toThrow('NEAR Intents refundTo mismatch')
    pioneerRefundTo = undefined
  })

  test(`NEAR ${source.name}: 1Click refundTo that is not the sender is refused`, async () => {
    pioneerRefundTo = undefined
    oneClick(200, intent('keepkey.near'))
    await expect(quote(source)).rejects.toThrow('NEAR Intents 1Click refundTo mismatch')
  })

  test(`NEAR ${source.name}: a deposit that needs a memo/destination tag is refused`, async () => {
    pioneerRefundTo = undefined
    oneClick(200, intent(source.sender, '123456'))
    await expect(quote(source)).rejects.toThrow('requires a memo/destination tag')
  })

  test(`NEAR ${source.name}: an unregistered deposit address is refused`, async () => {
    pioneerRefundTo = undefined
    oneClick(404, {})
    await expect(quote(source)).rejects.toThrow('1Click returned 404')
  })
}

test('NEAR: a quote without a sender address is refused instead of skipping the comparison', async () => {
  pioneerRefundTo = 'keepkey.near'
  oneClick(200, intent('keepkey.near'))
  await expect(quote(sources[2], '')).rejects.toThrow('quote has no sender address')
  pioneerRefundTo = undefined
})
