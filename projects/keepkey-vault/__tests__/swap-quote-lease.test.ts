import { expect, test } from 'bun:test'
import { createSwapQuoteLeases } from '../src/bun/swap-quote-lease'
import { assessSwapRisk } from '../src/shared/swap-risk'
import type { ExecuteSwapParams, SwapAsset, SwapQuote, SwapQuoteParams } from '../src/shared/types'
import { parseQuoteResponse } from '../src/bun/swap-parsing'

const from = { chainId: 'ethereum', decimals: 18 } as SwapAsset
const to = { chainId: 'ripple', decimals: 6 } as SwapAsset
const request: SwapQuoteParams = { fromCaip: 'eip155:1/slip44:60', toCaip: 'ripple:0/slip44:144', amount: '0.003', fromAddress: 'sender', toAddress: 'recipient' }
const quote: SwapQuote = { inboundAddress: 'deposit', memo: '', expectedOutput: '6', minimumOutput: '5.9',
  fees: { affiliate: '0', outbound: '0', totalBps: 0 }, estimatedTime: 60, slippageBps: 100, integration: 'nearIntents', swapper: 'NEAR Intents' }
function setup(overrides: Partial<SwapQuote> = {}, riskOverrides = {}, requestOverrides: Partial<SwapQuoteParams> = {}) {
  let time = 1_000_000, serial = 0
  const leases = createSwapQuoteLeases(() => time, () => `fixture-${++serial}`)
  const params = { ...request, ...requestOverrides }
  const risk = assessSwapRisk({ inputAmount: 0.003, expectedAmount: 6, minimumAmount: 5.9,
    fromPriceUsd: 2000, toPriceUsd: 1, sameAssetUnits: false, ...riskOverrides })
  const issued = leases.issue(params, { ...quote, ...overrides }, from, to, 7, risk)
  const execution: ExecuteSwapParams = { quoteId: issued.quoteId, fromChainId: from.chainId, toChainId: to.chainId,
    fromCaip: params.fromCaip, toCaip: params.toCaip, amount: params.amount, memo: issued.memo, inboundAddress: issued.inboundAddress,
    expectedOutput: issued.expectedOutput, integration: issued.integration, swapper: issued.swapper, router: issued.router,
    relayTx: issued.relayTx, expiry: issued.expiry, isMax: params.isMax, fromEvmAddressIndex: params.fromEvmAddressIndex }
  return { leases, issued, execution, tick: (ms: number) => { time += ms }, risk }
}

test('unquoted execution and forged IDs cannot reach execution', () => {
  const { leases, execution } = setup()
  for (const quoteId of [undefined, 'provider-id']) expect(() => leases.claim({ ...execution, quoteId }, 7)).toThrow(/quoteId/)
})
for (const [key, value] of Object.entries({ fromCaip: 'eip155:10/slip44:60', toCaip: 'eip155:1/slip44:60',
  fromChainId: 'polygon', toChainId: 'tron', amount: '1', memo: 'changed', inboundAddress: 'attacker',
  expectedOutput: '999', router: 'attacker', expiry: 9999999, integration: 'relay', swapper: 'Relay',
  relayTx: { to: 'attacker', data: '0x' }, isMax: true, feeLevel: 1, fromAddressOverride: 'attacker',
  toAddressOverride: 'attacker', tokenDecimals: 6, fromEvmAddressIndex: 1 })) {
  test(`tampered ${key} is rejected before device access`, () => {
    const { leases, execution } = setup()
    expect(() => leases.claim({ ...execution, [key]: value }, 7)).toThrow(/mismatch/)
    leases.claim(execution, 7).finish(false) // a rejected attempt never poisons the valid quote
  })
}
test('quote data is immutable and relay bytes are compared independent of object property order', () => {
  const { leases, execution, issued } = setup({ relayTx: { to: 'router', data: '0x1234', value: '1', chainId: 1 } as any })
  issued.inboundAddress = 'mutated'
  issued.relayTx!.data = '0xdead'
  execution.relayTx = { chainId: 1, value: '1', data: '0x1234', to: 'router' } as any
  const claim = leases.claim(execution, 7)
  expect(claim.quote.inboundAddress).toBe('deposit')
  expect(claim.params.relayTx?.data).toBe('0x1234')
  claim.finish(false)
})
test('claim serializes different quotes as well as duplicate requests', () => {
  const a = setup()
  const other = a.leases.issue(request, quote, from, to, 7, a.risk)
  const claim = a.leases.claim(a.execution, 7)
  expect(() => a.leases.claim(a.execution, 7)).toThrow(/in progress/)
  expect(() => a.leases.claim({ ...a.execution, quoteId: other.quoteId }, 7)).toThrow(/in progress/)
  claim.finish(false)
  a.leases.claim(a.execution, 7).finish(false)
})
test('a signature attempt consumes the quote even after a lost response or cancellation', () => {
  const { leases, execution } = setup()
  const claim = leases.claim(execution, 7)
  claim.beforeSign(7)
  claim.finish(false)
  expect(() => leases.claim(execution, 7)).toThrow(/already used/)
})
test('successful execution consumes quote even if the caller never reported a sign callback', () => {
  const { leases, execution } = setup()
  leases.claim(execution, 7).finish(true)
  expect(() => leases.claim(execution, 7)).toThrow(/already used/)
})
test('expiry and session are checked at claim AND immediately before a signature', () => {
  for (const expired of [true, false]) {
    const { leases, execution, tick } = setup()
    const claim = leases.claim(execution, 7)
    if (expired) tick(60_000)
    expect(() => claim.beforeSign(expired ? 7 : 8)).toThrow(expired ? /expired/ : /session changed/)
    claim.finish(false)
    expect(() => leases.claim(execution, expired ? 7 : 8)).toThrow(expired ? /expired/ : /session changed/)
  }
})
test('provider expiry may shorten but never extend Vault age limits', () => {
  const { leases, execution, tick, issued } = setup({ expiry: 1010 })
  expect(issued.quoteExpiresAt).toBe(1_010_000)
  tick(10_000)
  expect(() => leases.claim(execution, 7)).toThrow(/expired/)
})
test('a provider without a deadline uses Vault freshness, while a past deadline fails closed', () => {
  const parsed = parseQuoteResponse({ data: [{ integration: 'thorchain', quote: { buyAmount: '6', amountOutMin: '5.9', raw: { expiry: 0, inbound_address: '0xdeposit', memo: '=:XRP.XRP:recipient' } } }] }, request)
  expect(parsed.expiry).toBeUndefined()
  const { issued } = setup(parsed)
  expect(issued.quoteExpiresAt).toBe(1_060_000)
  expect(() => setup({ expiry: 999 })).toThrow(/expired/)
})
test('large trades above the cost limit cannot be acknowledged through', () => {
  const { leases, execution } = setup({}, { inputAmount: 1, fromPriceUsd: 2000, expectedAmount: 1800, minimumAmount: 1700 })
  expect(() => leases.claim({ ...execution, riskAcknowledged: true }, 7)).toThrow(/5% cost limit/)
})
test('unknown prices require acknowledgment of this exact quote and age out after 30 seconds', () => {
  const { leases, execution, tick } = setup({}, { fromPriceUsd: 0 })
  expect(() => leases.claim(execution, 7)).toThrow(/acknowledge/)
  leases.claim({ ...execution, riskAcknowledged: true }, 7).finish(false)
  tick(30_000)
  expect(() => leases.claim({ ...execution, riskAcknowledged: true }, 7)).toThrow(/expired/)
})
test('MAX sends the exact fee-reserved quote amount, never recalculates a partial deposit', () => {
  const { leases, execution } = setup({ netFromAmount: '0.0029' }, {}, { isMax: true })
  const claim = leases.claim(execution, 7)
  expect(claim.params.amount).toBe('0.0029')
  expect(claim.params.isMax).toBe(false)
  expect(claim.params.fromAddressOverride).toBe('sender')
  expect(claim.params.toAddressOverride).toBe('recipient')
  claim.finish(false)
})
