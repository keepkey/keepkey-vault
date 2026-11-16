import { describe, expect, test } from 'bun:test'
import { parseQuoteResponse, assertRelayOrderRecipient } from '../src/bun/swap-parsing'

const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const router = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const requestId = '0x' + 'ab'.repeat(32)
const depositId = 'cd'.repeat(32)
const data = '0x49290c1c' + sender.slice(2).padStart(64, '0') + depositId
const params = { fromCaip: 'eip155:8453/slip44:60', toCaip: 'eip155:1/slip44:60', slippageBps: 300 }
function response() {
  const tx = { to: router, data, value: '6315000000000000', chainId: 8453 }
  return { integration: 'relay', quote: {
    source: 'relay', swapper: 'Relay', amountOut: '0.0062', amountOutMin: '0.006',
    relayRequestId: requestId,
    txs: [{ type: 'EVM', chain: 'eip155:8453', txParams: { ...tx, gasLimit: '32713', senderAddress: sender, recipientAddress: router } }],
    raw: { requestId, details: { recipient }, steps: [{ id: 'deposit', requestId, items: [{
      data: { ...tx, from: sender }, check: { endpoint: '/intents/status?requestId=' + requestId },
    }] }] },
  } }
}
const parse = (r = response()) => parseQuoteResponse([r], params)

describe('Relay tracking id and deposit id are separate', () => {
  test('accepts the observed live quote shape while binding its source transaction and recipient', () => {
    const quote = parse()
    expect(assertRelayOrderRecipient(quote, recipient)).toBe(recipient)
    expect(quote.relayOrder?.requestId).toBe(requestId)
    expect(quote.relayOrder?.deposit?.data.slice(-64)).toBe(depositId)
  })
  test.each(['to', 'data', 'value', 'chainId'] as const)('refuses changed normalized %s even with the correct payout address', field => {
    const r = response()
    Object.assign(r.quote.txs[0].txParams, { [field]: {
      to: recipient, data: data.slice(0,-64) + 'ef'.repeat(32), value: '6315000000000001', chainId: 1,
    }[field] })
    expect(() => assertRelayOrderRecipient(parse(r), recipient)).toThrow(/different Relay order/)
  })
  test('still refuses a different payout recipient', () => {
    const quote = parse()
    expect(() => assertRelayOrderRecipient(quote, sender)).toThrow(/not the recipient/)
  })
  test('still refuses missing payout details', () => {
    const r = response()
    delete (r.quote.raw.details as any).recipient
    expect(() => assertRelayOrderRecipient(parse(r), recipient)).toThrow(/did not say who/)
  })
  test('ambiguous or missing raw transactions fail closed', () => {
    for (const count of [0, 2]) {
      const r = response()
      r.quote.raw.steps[0].items = Array.from({ length: count }, () => r.quote.raw.steps[0].items[0])
      expect(() => assertRelayOrderRecipient(parse(r), recipient)).toThrow(/different Relay order/)
    }
  })
  test('an approval step does not change the bound deposit', () => {
    const r = response()
    r.quote.raw.steps.unshift({ ...structuredClone(r.quote.raw.steps[0]), id: 'approve' })
    expect(assertRelayOrderRecipient(parse(r), recipient)).toBe(recipient)
  })
  test('raw chain and amount must be explicit, not guessed', () => {
    for (const field of ['value', 'chainId']) {
      const r = response()
      delete (r.quote.raw.steps[0].items[0].data as any)[field]
      expect(() => assertRelayOrderRecipient(parse(r), recipient)).toThrow(/different Relay order/)
    }
  })
})
