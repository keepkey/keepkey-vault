import { afterEach, expect, mock, test } from 'bun:test'
import { CHAINS } from '../src/shared/chains'
import { isNearIntentsPlainDepositSource, isPlainSwapDeposit } from '../src/shared/swap-deposit-routing'

// Every NEAR Intents plain-deposit source must pass the two refund-address
// layers before a quote is returned: XRP and TRON joined the plain-deposit
// routing in 1.6.9 while the check still covered only BTC and Solana.
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; pioneerRefundTo = undefined })

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
mock.module('../src/bun/txbuilder', () => ({
  normalizeBchAddress: (address: string) => address,
  // A sentinel makes reaching the builder visible without ever constructing,
  // signing or broadcasting a real transaction in these execution-path tests.
  buildTx: async () => { throw new Error('fixture builder reached') },
}))
const { getSwapQuote, executeSwap } = await import('../src/bun/swap')

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
const RECIPIENT = '0x2222222222222222222222222222222222222222' // not a burn address: swap.ts refuses those
const intent = (refundTo: string, depositMemo?: string | null) => ({
  status: 'PENDING_DEPOSIT',
  quoteResponse: {
    quoteRequest: {
      depositType: 'ORIGIN_CHAIN', refundTo, refundType: 'ORIGIN_CHAIN',
      recipient: RECIPIENT, recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    },
    quote: { depositAddress: DEPOSIT, ...(depositMemo !== undefined ? { depositMemo } : {}) },
  },
})
const quote = (source: typeof sources[number], fromAddress = source.sender, toAddress = RECIPIENT) =>
  getSwapQuote({ fromCaip: source.caip, toCaip: 'eip155:1/slip44:60', amount: '10', fromAddress, toAddress } as any)

// The address string alone does not establish where a refund/payout goes.
// Use the actual 1Click status/quoteRequest shape and mutate one binding at a
// time: every plain-deposit builder must reject the same unsafe records.
const unsafeRecords: Array<{ name: string; mutate: (record: any) => void; message: RegExp }> = [
  { name: 'missing deposit address', mutate: r => { delete r.quoteResponse.quote.depositAddress }, message: /cannot confirm deposit details/ },
  { name: 'different deposit address', mutate: r => { r.quoteResponse.quote.depositAddress = 'another-deposit' }, message: /different deposit address/ },
  { name: 'internal deposit', mutate: r => { r.quoteResponse.quoteRequest.depositType = 'INTENTS' }, message: /deposit is not on the source chain/ },
  { name: 'unconfirmed deposit type', mutate: r => { delete r.quoteResponse.quoteRequest.depositType }, message: /deposit is not on the source chain/ },
  { name: 'internal refund', mutate: r => { r.quoteResponse.quoteRequest.refundType = 'INTENTS' }, message: /not to an address on the chain/ },
  { name: 'confidential internal refund', mutate: r => { r.quoteResponse.quoteRequest.refundType = 'CONFIDENTIAL_INTENTS' }, message: /not to an address on the chain/ },
  { name: 'unconfirmed refund type', mutate: r => { delete r.quoteResponse.quoteRequest.refundType }, message: /not to an address on the chain/ },
  { name: 'different payout recipient', mutate: r => { r.quoteResponse.quoteRequest.recipient = '0x1111111111111111111111111111111111111111' }, message: /not your address/ },
  { name: 'internal payout', mutate: r => { r.quoteResponse.quoteRequest.recipientType = 'INTENTS' }, message: /not to an address on the chain/ },
  { name: 'missing payout recipient', mutate: r => { delete r.quoteResponse.quoteRequest.recipient }, message: /did not say where/ },
  { name: 'expired deposit deadline', mutate: r => { r.quoteResponse.quoteRequest.deadline = new Date(Date.now() - 1000).toISOString() }, message: /has passed or cannot be read/ },
  { name: 'missing deposit deadline', mutate: r => { delete r.quoteResponse.quoteRequest.deadline }, message: /has passed or cannot be read/ },
  { name: 'invalid deposit deadline', mutate: r => { r.quoteResponse.quoteRequest.deadline = 'not-a-deadline' }, message: /has passed or cannot be read/ },
  ...['KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'].map(status => ({
    name: `deposit already ${status}`, mutate: (r: any) => { r.status = status }, message: /not waiting for a deposit/,
  })),
]

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

  for (const record of unsafeRecords) test(`NEAR ${source.name}: ${record.name} is refused before returning a quote`, async () => {
    const reply = intent(source.sender)
    record.mutate(reply)
    oneClick(200, reply)
    await expect(quote(source)).rejects.toThrow(record.message)
  })

  test(`NEAR ${source.name}: EVM recipient letter case does not reject the same destination`, async () => {
    const reply = intent(source.sender)
    reply.quoteResponse.quoteRequest.recipient = RECIPIENT.toLowerCase()
    oneClick(200, reply)
    await expect(quote(source)).resolves.toMatchObject({ swapper: 'NEAR Intents' })
  })
}

test('NEAR: a quote without a sender address is refused instead of skipping the comparison', async () => {
  pioneerRefundTo = 'keepkey.near'
  oneClick(200, intent('keepkey.near'))
  await expect(quote(sources[2], '')).rejects.toThrow('quote has no sender address')
  pioneerRefundTo = undefined
})

test('NEAR: a quote without a payout recipient is refused instead of leaving it unverified', async () => {
  oneClick(200, intent(sources[2].sender))
  await expect(quote(sources[2], sources[2].sender, '')).rejects.toThrow('quote has no recipient address')
})

test('NEAR BCH: refund comparison accepts CashAddr with or without its chain prefix', async () => {
  const bare = 'qSenderCashAddressFixture'
  const source = { name: 'BCH', caip: caip('bitcoincash'), sender: `bitcoincash:${bare}` }
  for (const refundTo of [bare, source.sender]) {
    oneClick(200, intent(refundTo))
    await expect(quote(source)).resolves.toMatchObject({ swapper: 'NEAR Intents' })
  }
})

for (const source of sources.filter(source => source.sender !== source.sender.toLowerCase())) {
  test(`NEAR ${source.name}: base58 refund addresses are compared case-sensitively`, async () => {
    oneClick(200, intent(source.sender.toLowerCase()))
    await expect(quote(source)).rejects.toThrow('1Click refundTo mismatch')
  })
}

const executionSources = sources.filter(source => ['XRP', 'TRX', 'USDT-TRON'].includes(source.name))
function execute(source: typeof sources[number], overrides: Record<string, unknown> = {}) {
  return executeSwap({
    fromChainId: source.name === 'XRP' ? 'ripple' : 'tron', toChainId: 'ethereum',
    fromCaip: source.caip, toCaip: 'eip155:1/slip44:60', amount: '10',
    memo: '', inboundAddress: DEPOSIT, expectedOutput: '0.01',
    fromAddressOverride: source.sender, toAddressOverride: RECIPIENT,
    integration: 'nearIntents', swapper: 'NEAR Intents', ...overrides,
  } as any, {
    wallet: {}, getAllChains: () => CHAINS, getEvmRpcSource: () => undefined,
    getBtcXpub: () => undefined, getAllBtcXpubs: () => [],
    wrapSign: (sign: any) => sign(), pushSubStage: () => {},
  } as any)
}

for (const source of executionSources) {
  test(`NEAR ${source.name} execution: verifies a registered deposit before building`, async () => {
    const calls = oneClick(200, intent(source.sender))
    await expect(execute(source)).rejects.toThrow('fixture builder reached')
    expect(calls).toEqual([`https://1click.chaindefuser.com/v0/status?depositAddress=${DEPOSIT}`])
  })
  test(`NEAR ${source.name} execution: a wrong refund wallet stops before building`, async () => {
    oneClick(200, intent('keepkey.near'))
    await expect(execute(source)).rejects.toThrow(/refund.*mismatch|not your address/)
  })
  test(`NEAR ${source.name} execution: a required deposit memo stops before building`, async () => {
    oneClick(200, intent(source.sender, '123456'))
    await expect(execute(source)).rejects.toThrow(/requires a memo\/destination tag/)
  })
  test(`NEAR ${source.name} execution: an unknown deposit stops before building`, async () => {
    oneClick(404, {})
    await expect(execute(source)).rejects.toThrow(/1Click returned 404/)
  })
  test(`NEAR ${source.name} execution: a provider timeout stops before building`, async () => {
    globalThis.fetch = (async () => { throw new Error('fixture timeout') }) as typeof fetch
    await expect(execute(source)).rejects.toThrow(/failed to verify refund address.*fixture timeout/)
  })
  test(`NEAR ${source.name} execution: malformed provider JSON stops before building`, async () => {
    globalThis.fetch = (async () => new Response('{not JSON', { status: 200 })) as typeof fetch
    await expect(execute(source)).rejects.toThrow(/failed to verify refund address/)
  })
  test(`NEAR ${source.name} execution: a memo or prebuilt transaction cannot replace the plain deposit`, async () => {
    const calls = oneClick(200, intent(source.sender))
    for (const override of [{ memo: 'unreviewed-memo' }, { relayTx: { to: 'different-deposit', data: '0x' } }]) {
      await expect(execute(source, override)).rejects.toThrow(/requires a plain deposit/)
    }
    expect(calls).toEqual([])
  })
  test(`NEAR ${source.name} execution: assets cannot name chains different from the signer`, async () => {
    const calls = oneClick(200, intent(source.sender))
    for (const override of [{ fromCaip: 'eip155:1/slip44:60' }, { toCaip: caip('solana') }]) {
      await expect(execute(source, override)).rejects.toThrow(/assets do not match the execution chains/)
    }
    expect(calls).toEqual([])
  })
  test(`NEAR ${source.name} execution: integration identity still enforces safety without a swapper label`, async () => {
    oneClick(200, intent('keepkey.near'))
    await expect(execute(source, { swapper: undefined })).rejects.toThrow(/refund.*mismatch|not your address/)
  })
  for (const record of unsafeRecords) test(`NEAR ${source.name} execution: ${record.name} stops before building`, async () => {
    const reply = intent(source.sender)
    record.mutate(reply)
    oneClick(200, reply)
    await expect(execute(source)).rejects.toThrow(record.message)
  })
}
